import { createLiveToken, readEnv } from '../../server/backend'

export default async (): Promise<Response> => {
  const { status, body } = await createLiveToken(readEnv())
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export const config = { path: '/api/live/token' }
