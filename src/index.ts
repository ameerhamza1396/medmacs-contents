import contentHandler from './api/content';

type Env = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  [name: string]: any;
};

const applyWorkerEnv = (env: Env) => {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string') process.env[name] = value;
  }
};

const parseRequestBody = async (request: Request) => {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const text = await request.text();
  if (!text) return {};

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return JSON.parse(text);
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(text);
    const body: Record<string, string> = {};
    params.forEach((value, key) => {
      body[key] = value;
    });
    return body;
  }
  return text;
};

const toVercelRequest = async (request: Request) => {
  const url = new URL(request.url);
  
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    method: request.method,
    query,
    headers,
    body: await parseRequestBody(request),
  };
};

const createVercelResponse = () => {
  let status = 200;
  const headers = new Headers();
  let resolveResponse: (response: Response) => void;
  const response = new Promise<Response>(resolve => {
    resolveResponse = resolve;
  });

  const finish = (body?: BodyInit | null) => {
    resolveResponse(new Response(body ?? null, { status, headers }));
    return adapter;
  };

  const adapter = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      return adapter;
    },
    status(statusCode: number) {
      status = statusCode;
      return adapter;
    },
    json(payload: unknown) {
      headers.set('Content-Type', 'application/json; charset=utf-8');
      return finish(JSON.stringify(payload));
    },
    send(payload?: BodyInit | Record<string, unknown> | null) {
      if (payload && typeof payload === 'object' && !(payload instanceof ArrayBuffer) && !(payload instanceof Blob)) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
        return finish(JSON.stringify(payload));
      }
      return finish(payload as BodyInit | null);
    },
    end(body?: BodyInit | null) {
      return finish(body);
    },
  };

  return { adapter, response };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/api/content') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    applyWorkerEnv(env);
    const { adapter, response } = createVercelResponse();
    await contentHandler(await toVercelRequest(request) as any, adapter as any);
    return response;
  },
};
