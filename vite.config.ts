import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

/** Solo sviluppo: POST /__shot?name=x salva un fotogramma in tools/out/shots (verifica visiva). */
function shots(): Plugin {
  return {
    name: 'dev-shots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const url = new URL(req.url ?? '', 'http://x')
        const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w.-]/g, '_')
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          const dir = path.resolve('tools/out/shots')
          fs.mkdirSync(dir, { recursive: true })
          const b64 = Buffer.concat(chunks).toString().replace(/^data:image\/\w+;base64,/, '')
          fs.writeFileSync(path.join(dir, name + '.jpg'), Buffer.from(b64, 'base64'))
          res.end('ok')
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [shots()],
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
  server: { port: 5180 },
})
