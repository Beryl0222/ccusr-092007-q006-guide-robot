import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMission } from './contracts.js';
import { MissionRuntime } from './runtime.js';
import { EdgeBuffer } from './offlineBuffer.js';
import { buildTimeline, incidentReport, renderConsole } from './replay.js';

const DEFAULT_MISSION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'robot_mission.json');

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  const payload = contentType.startsWith('application/json') ? JSON.stringify(body, null, 2) : body;
  res.writeHead(status, { 'content-type': contentType });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 可独立运行的伴游任务后端（仅依赖 Node 标准库）。 */
export async function createServer({ missionPath = DEFAULT_MISSION_PATH } = {}) {
  const record = await loadMission(missionPath);
  const mission = record.mission;
  const runtime = new MissionRuntime(mission);
  const buffer = new EdgeBuffer({ consent: mission.consent });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, mission_id: mission.mission_id });
      }
      if (req.method === 'GET' && url.pathname === '/mission') {
        return send(res, 200, mission);
      }
      if (req.method === 'GET' && url.pathname === '/state') {
        return send(res, 200, runtime.state);
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        return send(res, 200, runtime.log.events);
      }
      if (req.method === 'POST' && url.pathname === '/events') {
        const event = JSON.parse(await readBody(req));
        const result = runtime.ingest(event, url.searchParams.get('received_at') ?? undefined);
        return send(res, result.accepted ? 200 : 409, {
          accepted: result.accepted,
          reason: result.reason ?? null,
          notes: result.notes ?? [],
        });
      }
      if (req.method === 'GET' && url.pathname === '/timeline') {
        return send(res, 200, buildTimeline(mission, runtime.log.events).entries);
      }
      if (req.method === 'GET' && url.pathname === '/incidents') {
        return send(res, 200, incidentReport(mission, runtime.log.events));
      }
      if (req.method === 'GET' && url.pathname === '/console') {
        const { entries } = buildTimeline(mission, runtime.log.events);
        return send(res, 200, renderConsole(entries), 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && url.pathname === '/buffer') {
        const item = JSON.parse(await readBody(req));
        return send(res, 200, buffer.record(item));
      }
      if (req.method === 'POST' && url.pathname === '/sync') {
        const { purpose } = JSON.parse(await readBody(req));
        if (!purpose) return send(res, 400, { error: '缺少 purpose' });
        return send(res, 200, buffer.sync(purpose));
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      return send(res, 400, { error: String(err.message ?? err) });
    }
  });

  return { server, runtime, buffer, mission };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080);
  const { server, mission } = await createServer({
    missionPath: process.env.MISSION_PATH ?? DEFAULT_MISSION_PATH,
  });
  server.listen(port, () => {
    console.log(`伴游任务后端已启动: http://localhost:${port} (mission ${mission.mission_id}, device ${mission.device.device_id})`);
  });
}
