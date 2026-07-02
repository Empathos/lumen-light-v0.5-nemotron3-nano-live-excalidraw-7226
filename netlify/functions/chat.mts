import { type ChatMessage, chatConfig, readEnv, runChatTurn } from '../../server/backend'

export default async (req: Request): Promise<Response> => {
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  if (req.method === 'GET') return json(200, chatConfig(readEnv()))
  if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' })

  let messages: ChatMessage[] | undefined
  try {
    messages = ((await req.json()) as { messages?: ChatMessage[] }).messages
  } catch {
    return json(400, { error: 'Invalid JSON body.' })
  }
  if (!Array.isArray(messages)) return json(400, { error: 'Missing messages array.' })

  const { status, body } = await runChatTurn(readEnv(), messages)
  return json(status, body)
}

export const config = { path: '/api/chat' }
