import { ipcMain } from 'electron'
import { getDatabase } from '../services/db'
import { nanoid } from 'nanoid'
import { jsonrepair } from 'jsonrepair'
import log from 'electron-log'

interface AIStreamRequest {
  id: string
  modelId: string
  baseUrl: string
  apiKey: string
  messages: Array<{ role: string, content: string }>
  temperature?: number
  maxTokens?: number
}

const activeStreams = new Map<string, AbortController>()

function safeParseAIJson(raw: string): { data: unknown } | { error: string } {
  try {
    const jsonBlock = extractJsonBlock(raw)
    const repaired = jsonrepair(jsonBlock)
    return { data: JSON.parse(repaired) }
  } catch (e) {
    return { error: `JSON parse failed after repair: ${(e as Error).message}` }
  }
}

function extractJsonBlock(s: string): string {
  const mdMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (mdMatch) return mdMatch[1].trim()

  const firstBrace = s.indexOf('{')
  const firstBracket = s.indexOf('[')
  const start = firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket)

  if (start === -1) return s

  let end = s.length
  const openBrace = firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)
  if (openBrace) {
    let depth = 0
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
  } else {
    let depth = 0
    for (let i = start; i < s.length; i++) {
      if (s[i] === '[') depth++
      else if (s[i] === ']') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
  }

  return s.slice(start, end)
}

export function registerAiHandlers(): void {
  log.info('Registering AI handlers')

  ipcMain.handle('ai:stream', async (event, request: AIStreamRequest) => {
    log.info(`AI stream started: id=${request.id}, model=${request.modelId}`)
    const controller = new AbortController()
    activeStreams.set(request.id, controller)

    try {
      log.info(`Sending request to ${request.baseUrl}/chat/completions`)
      const response = await fetch(`${request.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.apiKey}`
        },
        body: JSON.stringify({
          model: request.modelId,
          stream: true,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 16000
        }),
        signal: controller.signal
      })

      if (!response.ok) {
        const errorText = await response.text()
        log.error(`AI stream HTTP error: ${response.status} ${response.statusText}`, errorText)
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') {
              event.sender.send('ai:done', { id: request.id })
              return { success: true }
            }

            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content
              if (content) {
                event.sender.send('ai:token', { id: request.id, token: content })
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }

      event.sender.send('ai:done', { id: request.id })
      log.info(`AI stream completed: id=${request.id}`)
      return { success: true }
    } catch (error: unknown) {
      activeStreams.delete(request.id)
      let message = error instanceof Error ? error.message : 'Unknown error'
      // Provide actionable diagnostics for common failures
      if (message === 'fetch failed' || message.includes('fetch')) {
        message = `无法连接到 AI 服务 (${request.baseUrl})，请确认：\n1. AI 服务是否已启动\n2. 地址和端口是否正确\n3. 防火墙是否阻止了连接`
      } else if (message.includes('ECONNREFUSED')) {
        message = `AI 服务拒绝连接 (${request.baseUrl})，请确认服务已启动`
      }
      log.error(`AI stream error: id=${request.id}, error=${message}`)
      event.sender.send('ai:error', { id: request.id, error: message })
      return { success: false, error: message }
    }
  })

  ipcMain.handle('ai:abort', async (_, id: string) => {
    log.info(`AI stream abort requested: id=${id}`)
    const controller = activeStreams.get(id)
    if (controller) {
      controller.abort()
      activeStreams.delete(id)
      log.info(`AI stream aborted: id=${id}`)
      return { success: true }
    }
    log.warn(`AI stream not found for abort: id=${id}`)
    return { success: false, error: 'Stream not found' }
  })

  ipcMain.handle('ai:connection-test', async (_, { baseUrl, apiKey, modelId }) => {
    log.info(`AI connection test: model=${modelId}, baseUrl=${baseUrl}`)
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 10
        })
      })

      if (response.ok) {
        return { success: true }
      } else {
        const error = await response.text()
        return { success: false, error: `Connection failed: ${response.status} ${error}` }
      }
    } catch (error: unknown) {
      const msg = (error as Error).message
      if (msg === 'fetch failed' || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        return { success: false, error: `无法连接到 AI 服务 (${baseUrl})，请确认服务是否已启动` }
      }
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('ai:safe-parse-json', async (_, raw: string) => {
    return safeParseAIJson(raw)
  })

  // ── Classification with JSON Schema enforcement ──
  // Strategy:
  //   1. Ollama → native /api/chat with format=<schema> (strict)
  //   2. OpenAI-compatible → try response_format: json_schema (strict); on 400 fall back to json_object
  //   3. On parse failure, retry once with temperature 0 and stricter system reminder
  ipcMain.handle('ai:classify', async (_, request: {
    baseUrl: string; modelId: string; apiKey: string
    messages: Array<{ role: string; content: string }>
    jsonSchema: Record<string, unknown>
    schemaName?: string
    maxTokens?: number
  }) => {
    log.info(`AI classify: model=${request.modelId}`)
    const isOllama = /localhost:11434|127\.0\.0\.1:11434/.test(request.baseUrl)
    const schemaName = request.schemaName || 'classification'
    const maxTokens = request.maxTokens ?? 1200

    async function callOllama(messages: typeof request.messages): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
      const ollamaBase = request.baseUrl.replace(/\/v1\/?$/, '')
      const resp = await fetch(`${ollamaBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelId,
          messages,
          format: request.jsonSchema,
          stream: false,
          options: { temperature: 0.1 },
        }),
      })
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}` }
      const data = await resp.json()
      return { ok: true, content: data.message?.content || '' }
    }

    async function callOpenAI(messages: typeof request.messages, temperature: number, useSchema: boolean): Promise<{ ok: true; content: string } | { ok: false; error: string; status?: number }> {
      const body: Record<string, unknown> = {
        model: request.modelId,
        messages,
        temperature,
        max_tokens: maxTokens,
      }
      if (useSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: schemaName, schema: request.jsonSchema, strict: true },
        }
      } else {
        body.response_format = { type: 'json_object' }
      }
      const resp = await fetch(`${request.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${request.apiKey}` },
        body: JSON.stringify(body),
      })
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}: ${await resp.text()}`, status: resp.status }
      const data = await resp.json()
      return { ok: true, content: data.choices?.[0]?.message?.content || '' }
    }

    function parse(content: string): { data: unknown } | { error: string } {
      try { return { data: JSON.parse(content) } } catch {/* fall through */}
      const repaired = safeParseAIJson(content)
      if ('data' in repaired) return { data: repaired.data }
      return { error: `JSON parse: ${content.slice(0, 120)}` }
    }

    try {
      // ── Attempt 1 ──
      let firstError: string | undefined
      if (isOllama) {
        const r = await callOllama(request.messages)
        if (r.ok) {
          const p = parse(r.content)
          if ('data' in p) return { success: true, data: p.data }
          firstError = p.error
        } else firstError = r.error
      } else {
        // Try strict json_schema first
        let r = await callOpenAI(request.messages, 0.1, true)
        // 400 usually means the model/provider doesn't support json_schema → fall back
        if (!r.ok && r.status === 400) r = await callOpenAI(request.messages, 0.1, false)
        if (r.ok) {
          const p = parse(r.content)
          if ('data' in p) return { success: true, data: p.data }
          firstError = p.error
        } else firstError = r.error
      }

      // ── Attempt 2: retry at temperature 0 with a stricter reminder ──
      const stricter = [
        ...request.messages,
        { role: 'system' as const, content: '上一次输出未通过 JSON 解析。请严格输出符合 schema 的 JSON，不要包含任何解释、markdown 代码块或多余字符。' },
      ]
      if (isOllama) {
        const r = await callOllama(stricter)
        if (r.ok) {
          const p = parse(r.content)
          if ('data' in p) return { success: true, data: p.data }
          return { success: false, error: `${firstError}; retry: ${p.error}` }
        }
        return { success: false, error: `${firstError}; retry: ${r.error}` }
      } else {
        const r = await callOpenAI(stricter, 0, false)
        if (r.ok) {
          const p = parse(r.content)
          if ('data' in p) return { success: true, data: p.data }
          return { success: false, error: `${firstError}; retry: ${p.error}` }
        }
        return { success: false, error: `${firstError}; retry: ${r.error}` }
      }
    } catch (error: unknown) {
      const msg = (error as Error).message
      if (msg === 'fetch failed' || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        return { success: false, error: `无法连接到 AI 服务 (${request.baseUrl})，请确认服务是否已启动` }
      }
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('ai:complete', async (_, request: {
    baseUrl: string; modelId: string; apiKey: string
    messages: Array<{ role: string; content: string }>
    temperature?: number; maxTokens?: number
    abortId?: string
  }) => {
    log.info(`AI complete: model=${request.modelId}`)
    const controller = new AbortController()
    if (request.abortId) activeStreams.set(request.abortId, controller)
    try {
      const response = await fetch(`${request.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${request.apiKey}`
        },
        body: JSON.stringify({
          model: request.modelId,
          stream: false,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens ?? 16000
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const errText = await response.text()
        return { success: false, error: `HTTP ${response.status}: ${errText}` }
      }
      const data = await response.json()
      const content = data.choices?.[0]?.message?.content || ''
      return { success: true, data: content }
    } catch (error: unknown) {
      const msg = (error as Error).message
      if (msg === 'fetch failed' || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        return { success: false, error: `无法连接到 AI 服务 (${request.baseUrl})，请确认服务是否已启动` }
      }
      return { success: false, error: msg }
    } finally {
      if (request.abortId) activeStreams.delete(request.abortId)
    }
  })

  ipcMain.handle('ai:embed', async (_, request: { baseUrl: string; model: string; prompt: string; apiKey?: string }) => {
    log.info(`AI embed: model=${request.model}, baseUrl=${request.baseUrl}`)
    try {
      const isOllama = request.baseUrl.includes('localhost:11434') || request.baseUrl.includes('127.0.0.1:11434')

      let embedding: number[]

      if (isOllama) {
        // Ollama native embeddings endpoint
        const embedBase = request.baseUrl.replace(/\/v1\/?$/, '')
        const response = await fetch(`${embedBase}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: request.model, prompt: request.prompt }),
        })
        if (!response.ok) throw new Error(`Ollama embedding API returned ${response.status}`)
        const data = await response.json()
        embedding = data.embedding as number[]
      } else {
        // OpenAI-compatible embeddings endpoint
        const url = `${request.baseUrl}/embeddings`
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (request.apiKey) {
          headers['Authorization'] = `Bearer ${request.apiKey}`
        }
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: request.model, input: request.prompt }),
        })
        if (!response.ok) throw new Error(`OpenAI embedding API returned ${response.status}`)
        const data = await response.json()
        embedding = data.data?.[0]?.embedding
        if (!embedding || !Array.isArray(embedding)) {
          throw new Error('Unexpected embedding response format')
        }
      }

      return { success: true, data: embedding }
    } catch (error: unknown) {
      const msg = (error as Error).message
      if (msg === 'fetch failed' || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
        return { success: false, error: `无法连接到 AI 服务 (${request.baseUrl})，请确认服务是否已启动` }
      }
      return { success: false, error: msg }
    }
  })
}