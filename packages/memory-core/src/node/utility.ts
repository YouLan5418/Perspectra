/** Native model protocol transport. Credentials stay in the model-specific Core worker. */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WorldJsonObject, WorldJsonValue } from '@perspectra/sdk/contracts'
import { list, object, text } from './archive.ts'
import { record } from './queries.ts'
import { utilityPrompt, type MemoryUtility } from './episodes.ts'

export interface MemoryModel {
  readonly protocol: string
  readonly endpoint: string
  readonly model: string
  readonly apiKey?: string
}

export interface UtilityTraceRecord extends WorldJsonObject {
  readonly event: string
  readonly atMs: number
}

export interface UtilityOptions {
  readonly tracePath?: string
  readonly metadata?: WorldJsonObject
  readonly onTrace?: (record: UtilityTraceRecord) => void
  readonly timeoutMs?: number
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

type UtilityRequest = { endpoint: string; headers: Record<string, string>; body: WorldJsonObject }

export function utilityRequest(model: MemoryModel, system: string, user: string, limit: number): UtilityRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  let endpoint = model.endpoint,
    body: WorldJsonObject
  if (model.protocol === 'openai') {
    body = {
      model: model.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: limit,
      ...(model.model.toLowerCase().includes('gemini')
        ? { reasoning_effort: 'low' }
        : { thinking: { type: 'disabled' } }),
    }
    if (model.apiKey) headers.authorization = 'Bearer ' + model.apiKey
  } else if (model.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (model.apiKey) headers['x-api-key'] = model.apiKey
    body = {
      model: model.model,
      system: system + '\n只返回所要求的 JSON 对象，不要 Markdown 或解释。',
      messages: [{ role: 'user', content: user }],
      max_tokens: limit,
    }
  } else if (model.protocol === 'google') {
    if (model.apiKey) headers['x-goog-api-key'] = model.apiKey
    const url = new URL(endpoint)
    if (!/\/models\/[^/]+:generateContent$/.test(url.pathname))
      throw new Error('Google endpoint must end in /models/model:generateContent')
    url.pathname = url.pathname.replace(
      /\/models\/[^/]+:generateContent$/,
      '/models/' + encodeURIComponent(model.model.replace(/^models\//, '')) + ':generateContent',
    )
    endpoint = url.href
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: limit, temperature: 0, responseMimeType: 'application/json' },
    }
  } else throw new Error('Unsupported memory model protocol')
  return { endpoint, headers, body }
}

export function utilityResponse(
  response: WorldJsonObject,
  protocol: string,
): { value: WorldJsonValue | undefined; finish: WorldJsonValue | undefined; usage?: WorldJsonValue } {
  if (protocol === 'openai') {
    const choice = object(list(response.choices)[0]),
      message = object(choice.message),
      result = {
        value: message.content || record(record(list(message.tool_calls ?? [])[0]).function).arguments,
        finish: choice.finish_reason,
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      }
    return result
  }
  if (protocol === 'anthropic')
    return {
      value: list(response.content ?? [])
        .map(record)
        .filter(block => block.type === 'text')
        .map(block => text(block.text ?? ''))
        .join(''),
      finish: response.stop_reason,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    }
  const candidate = record(list(response.candidates ?? [])[0]),
    result: { value: WorldJsonValue | undefined; finish: WorldJsonValue | undefined; usage?: WorldJsonValue } = {
      value: list(record(candidate.content).parts ?? [])
        .map(record)
        .filter(part => !part.thought)
        .map(part => text(part.text ?? ''))
        .join(''),
      finish: candidate.finishReason,
      ...(response.usageMetadata === undefined ? {} : { usage: response.usageMetadata }),
    }
  return result
}

function recordAttempt(options: UtilityOptions, row: UtilityTraceRecord): void {
  if (options.tracePath) appendFileSync(options.tracePath, JSON.stringify(row) + '\n')
  options.onTrace?.(row)
}

function cancelled(): Error {
  return new Error('Memory model request cancelled')
}

function asObject(value: WorldJsonValue): WorldJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Memory model returned an invalid response')
  return value as WorldJsonObject
}

export function createUtility(
  model: MemoryModel,
  signal: AbortSignal,
  send: typeof fetch = fetch,
  options: UtilityOptions = {},
): MemoryUtility {
  return async (system, original, maxTokens) => {
    if (signal.aborted) throw cancelled()
    const user = utilityPrompt(original),
      limit = Math.min(24000, Math.max(maxTokens, Math.ceil([...user].length * 0.6))),
      request = utilityRequest(model, system, user, limit),
      gemini = model.protocol === 'openai' && model.model.toLowerCase().includes('gemini'),
      attempts = gemini ? 2 : 3,
      callId = randomUUID(),
      startedMetadata: WorldJsonObject = {
        ...(options.metadata ?? {}),
        callId,
        requestedModel: model.model,
        inputChars: [...user].length,
        originalInputChars: [...original].length,
        requestedMaxTokens: limit,
        timeoutSeconds: (options.timeoutMs ?? 120_000) / 1000,
      }
    let body = request.body,
      response: WorldJsonObject | undefined

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (signal.aborted) throw cancelled()
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000),
        combined = AbortSignal.any([signal, timeout]),
        start = performance.now(),
        atMs = Date.now()
      let failure: unknown,
        httpStatus: number | undefined,
        headersMs: number | undefined,
        bodyReadMs: number | undefined,
        invalidJson = false,
        timedOut = false
      recordAttempt(options, {
        ...startedMetadata,
        event: 'started',
        atMs,
        attempt: attempt + 1,
        reasoningEffort: body.reasoning_effort ?? null,
        thinkingType: object(body.thinking ?? {}).type ?? null,
      })
      try {
        const headerStart = performance.now(),
          http = await send(request.endpoint, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(body),
            signal: combined,
            redirect: 'error',
          })
        headersMs = performance.now() - headerStart
        httpStatus = http.status
        if (!http.ok) {
          try {
            await http.body?.cancel()
          } catch {
            // Keep the transport status as the diagnostic cause.
          }
          failure = new Error('HTTP failure')
        } else {
          const bodyStart = performance.now()
          try {
            response = asObject((await http.json()) as WorldJsonValue)
          } catch (error) {
            invalidJson = true
            failure = error
          }
          bodyReadMs = performance.now() - bodyStart
        }
      } catch (error) {
        failure = error
      }

      if (signal.aborted) {
        recordAttempt(options, {
          ...startedMetadata,
          event: 'finished',
          atMs: Date.now(),
          attempt: attempt + 1,
          durationMs: performance.now() - start,
          status: 'cancelled',
          httpStatus: httpStatus ?? null,
          headersMs: headersMs ?? null,
          bodyReadMs: bodyReadMs ?? null,
          willRetry: false,
          retryDelaySeconds: 0,
        })
        throw cancelled()
      }
      timedOut = timeout.aborted
      if (failure !== undefined) {
        const retry = !invalidJson && (gemini ? timedOut : true) && attempt + 1 < attempts
        recordAttempt(options, {
          ...startedMetadata,
          event: 'finished',
          atMs: Date.now(),
          attempt: attempt + 1,
          durationMs: performance.now() - start,
          status: 'failed',
          timedOut,
          errorType: invalidJson ? 'InvalidResponse' : httpStatus === undefined ? 'TransportError' : 'HttpError',
          httpStatus: httpStatus ?? null,
          headersMs: headersMs ?? null,
          bodyReadMs: bodyReadMs ?? null,
          willRetry: retry,
          retryDelaySeconds: retry ? 2 * (attempt + 1) : 0,
        })
        if (!retry)
          throw new Error(
            invalidJson
              ? 'Memory model returned invalid JSON'
              : timedOut
                ? 'Memory model timed out'
                : httpStatus === undefined
                  ? 'Memory model request failed'
                  : 'Memory model HTTP failure',
          )
        if (gemini) {
          const { reasoning_effort: _reasoningEffort, ...rest } = body
          body = { ...rest, thinking: { type: 'disabled' } }
        }
        try {
          await (
            options.sleep ?? ((milliseconds, waitSignal) => delay(milliseconds, undefined, { signal: waitSignal }))
          )(2000 * (attempt + 1), signal)
        } catch {
          throw cancelled()
        }
        continue
      }
      recordAttempt(options, {
        ...startedMetadata,
        event: 'finished',
        atMs: Date.now(),
        attempt: attempt + 1,
        durationMs: performance.now() - start,
        status: 'returned',
        timedOut: false,
        httpStatus: httpStatus ?? null,
        headersMs: headersMs ?? null,
        bodyReadMs: bodyReadMs ?? null,
        willRetry: false,
        retryDelaySeconds: 0,
        returnedModel:
          typeof response?.model === 'string'
            ? response.model
            : typeof response?.modelVersion === 'string'
              ? response.modelVersion
              : null,
        usage: response?.usage ?? response?.usageMetadata ?? null,
      })
      break
    }

    if (!response) throw new Error('Memory model request failed')
    let parsed: WorldJsonValue | undefined, finish: WorldJsonValue | undefined
    try {
      const result = utilityResponse(response, model.protocol)
      parsed = result.value
      finish = result.finish
      if (['length', 'max_tokens', 'MAX_TOKENS'].includes(String(finish)))
        throw new Error('Memory utility JSON exceeded output budget')
      if (typeof parsed !== 'string') throw new Error('Empty memory utility JSON')
      return asObject(
        JSON.parse(
          parsed
            .trim()
            .replace(/^```json/, '')
            .replace(/```$/, '')
            .trim(),
        ) as WorldJsonValue,
      )
    } catch (error) {
      const errorType =
        error instanceof Error && error.message.includes('exceeded output budget')
          ? 'OutputBudgetExceeded'
          : error instanceof Error && error.message.includes('Empty memory')
            ? 'EmptyResponse'
            : 'InvalidUtilityJson'
      recordAttempt(options, {
        ...startedMetadata,
        event: 'rejected',
        atMs: Date.now(),
        finishReason: finish ?? null,
        responseChars: typeof parsed === 'string' ? [...parsed].length : 0,
        errorType,
      })
      throw new Error(
        errorType === 'OutputBudgetExceeded'
          ? 'Memory utility JSON exceeded output budget'
          : errorType === 'EmptyResponse'
            ? 'Empty memory utility JSON'
            : 'Invalid memory utility JSON',
      )
    }
  }
}
