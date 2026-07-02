import { describeImage, readEnv } from '../../server/backend'

const json = (o: unknown, status: number) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
  try {
    const { dataURL, question } = (await req.json().catch(() => ({}))) as {
      dataURL?: string
      question?: string
    }
    if (!dataURL || typeof dataURL !== 'string') return json({ error: 'Missing dataURL.' }, 400)
    const { status, body } = await describeImage(readEnv(), dataURL, question)
    return json(body, status)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

export const config = { path: '/api/image/describe' }
