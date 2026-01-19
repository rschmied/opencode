import { Log } from "../util/log"
import { Config } from "../config/config"

const log = Log.create({ service: "provider:circuit" })

// Track in-flight refresh promises for providers to avoid concurrent refreshes
const refreshInFlight: Map<string, Promise<void>> = new Map()

// Apply a fetched token into provider state in a single place to avoid duplication
async function applyTokenToProvider(
  providerID: string,
  stateGetter: () => Promise<any>,
  apiKey: string,
  expiry: number,
) {
  const s = await stateGetter()
  const pv = s.providers[providerID]
  if (pv) {
    pv.options["headers"] = { ...(pv.options["headers"] || {}), "api-key": apiKey }
    pv.options["expiry"] = expiry
    log.info("Applied token to provider state", { providerID, newExpiry: new Date(expiry).toISOString() })
    return true
  }
  log.info("No provider found to apply token", { providerID })
  return false
}

function toPlainHeaders(headers: any): Record<string, any> {
  const out: Record<string, any> = {}
  if (!headers) return out
  if (typeof (headers as any).forEach === "function") {
    try {
      ;(headers as any).forEach((v: any, k: any) => (out[String(k).toLowerCase()] = v))
      return out
    } catch {}
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[String(k).toLowerCase()] = v
    return out
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) out[String(k).toLowerCase()] = v
    return out
  }
  return out
}

async function compactGeminiToolsIfNeeded(providerID: string, outUrl: any, headersObj: Record<string, any>, init: any) {
  const isGemini = typeof outUrl === "string" && /gemini/i.test(outUrl)
  const ct = String(headersObj["content-type"] || "")
  if (!isGemini || !ct.includes("application/json")) return false

  let payload: any = init.body
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload)
    } catch {
      payload = undefined
    }
  }
  if (!(payload && typeof payload === "object")) return false
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return false

  const originalTools = payload.tools
  const compact = originalTools.map((t: any) => {
    const fn = t.function || t
    const params = fn?.parameters?.properties || {}
    const simpleProps: Record<string, any> = {}
    for (const [k, v] of Object.entries(params)) {
      const pType = (v as any)?.type || (Array.isArray((v as any)?.anyOf) && (v as any).anyOf[0]?.type) || "string"
      simpleProps[k] = { type: pType }
    }
    return {
      type: t.type,
      function: {
        name: fn?.name,
        description: fn?.description,
        parameters: {
          type: "object",
          properties: simpleProps,
          required: fn?.parameters?.required || [],
        },
      },
    }
  })
  payload.tools = compact
  init.body = JSON.stringify(payload)
  log.info("compacted tools for Gemini", {
    providerID,
    toolsBefore: originalTools.length,
    toolsAfter: compact.length,
  })
  return true
}

export async function fetchToken(): Promise<{ apiKey: string; expiry: number; tokenData: any } | null> {
  const apiKey = process.env["CIRCUIT_API_KEY"]
  if (apiKey) {
    log.info("Using static CIRCUIT_API_KEY")
    return { apiKey, expiry: Date.now() + 365 * 24 * 60 * 60 * 1000, tokenData: {} }
  }

  const cid = process.env["CIRCUIT_CLIENT_ID"]
  const cs = process.env["CIRCUIT_CLIENT_SECRET"]
  if (!cid || !cs) {
    log.warn("CIRCUIT_CLIENT_ID and CIRCUIT_CLIENT_SECRET not set, skipping token fetch")
    return null
  }

  const url = "https://id.cisco.com/oauth2/default/v1/token"
  const payload = "grant_type=client_credentials&scope=customscope"
  const value = (() => {
    try {
      return btoa(`${cid}:${cs}`)
    } catch {
      return Buffer.from(`${cid}:${cs}`).toString("base64")
    }
  })()
  const headers = {
    Accept: "*/*",
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${value}`,
  }

  const response = await fetch(url, { method: "POST", headers, body: payload })
  if (!response.ok) {
    log.error("Token fetch failed", { status: response.status, statusText: response.statusText })
    throw new Error(`Token fetch failed: ${response.status}`)
  }
  const tokenData = await response.json()
  const accessToken = tokenData.access_token
  if (!accessToken) {
    log.error("No access_token in OAuth response", { tokenData })
    throw new Error("No access_token in response")
  }

  const expiresIn = tokenData.expires_in || 3600
  const expiry = Date.now() + expiresIn * 1000
  log.info("Token fetched", {
    expiresIn,
    expiry: new Date(expiry).toISOString(),
    scope: tokenData.scope,
    tokenType: tokenData.token_type,
    length: accessToken.length,
  })
  return { apiKey: accessToken, expiry, tokenData }
}

// appkey - is a required field to identify your application
// user - Optional parameter. Used to identify the user making the request
// session_id - Optional parameter (maintain conversational history)
export function buildUserString(sessionID?: string) {
  const appKey = process.env["CIRCUIT_APP_KEY"] ?? ""
  const circuitUser = (process.env["CIRCUIT_APP_USER"] ?? "").trim()
  const payload: Record<string, string> = { appkey: appKey }
  if (circuitUser) payload["user"] = circuitUser
  if (sessionID) payload["session_id"] = sessionID
  return JSON.stringify(payload)
}

export function createFetchWrapper(providerID: string, stateGetter: () => Promise<any>, originalFetch: typeof fetch) {
  return async (input: any, init: any = {}) => {
    // ensure headers exist and are mutable
    init = { ...(init || {}), headers: { ...(init?.headers || {}) } }

    // attach latest api-key from provider state
    const sLocal = await stateGetter()
    const provLocal = sLocal.providers[providerID]
    const currentKey = provLocal?.options?.["headers"]?.["api-key"]
    if (currentKey) init.headers["api-key"] = currentKey

    // Normalize headers for easier checks
    const headersObj = toPlainHeaders(init.headers)

    // Compact tools for the Gemini model if needed
    try {
      const outUrl = typeof input === "string" ? input : (input as any)?.url
      await compactGeminiToolsIfNeeded(providerID, outUrl, headersObj, init)
    } catch (err) {
      log.info("error compacting tools for Gemini", { error: (err as Error).message })
    }

    let res = await originalFetch(input, init)

    if (res && res.status === 401) {
      log.info("fetch wrapper detected 401, starting refresh", {
        providerID,
        url: typeof input === "string" ? input : input?.url,
      })

      // reuse or create refresh promise
      let p = refreshInFlight.get(providerID)
      if (!p) {
        p = (async () => {
          try {
            const result = await fetchToken()
            if (!result) throw new Error("Failed to fetch token for refresh")
            // persist into provider options (persist in-state)
            await applyTokenToProvider(providerID, stateGetter, result.apiKey, result.expiry)
          } finally {
            refreshInFlight.delete(providerID)
          }
        })()
        refreshInFlight.set(providerID, p)
      }

      // wait for refresh to finish (success or fail)
      try {
        await p
      } catch (err) {
        log.error("fetch wrapper refresh failed", {
          providerID,
          error: (err as Error)?.message,
        })
        return res
      }

      // retry once with updated key
      const s3 = await stateGetter()
      const pv2 = s3.providers[providerID]
      const newKey = pv2?.options?.["headers"]?.["api-key"]
      if (newKey) init.headers["api-key"] = newKey

      log.info("fetch wrapper retrying request after refresh", {
        providerID,
        url: typeof input === "string" ? input : input?.url,
      })

      res = await originalFetch(input, init)
    }

    return res
  }
}

/**
 * Mutates the provided `options` object in-place for the Circuit provider.
 * - Sets `baseURL` and `apiVersion`
 * - Refreshes expired tokens and persists them into provider state
 * - Wraps `fetch` to auto-refresh on 401 and compact Gemini tools
 *
 * Side effects:
 * - Persists updated `api-key` and `expiry` into the provider state via `stateGetter`
 *
 * Returns: void (mutates `options`)
 */
export async function prepareProvider(
  provider: any,
  model: any,
  stateGetter: () => Promise<any>,
  options: Record<string, any>,
) {
  const config = await Config.get()
  const circuitConfig = config.provider?.circuit
  if (!circuitConfig?.api) {
    log.error("Circuit provider API URL is missing", { providerID: provider.id, provider })
    throw new Error(`Provider ${provider.id} is missing required 'api' field. Check your opencode.json configuration.`)
  }
  options["baseURL"] = `${circuitConfig.api}/openai/deployments/${model.id}`
  options["apiVersion"] = options["apiVersion"] ?? "2025-04-01-preview"

  // If token expired, refresh synchronously before SDK creation
  if (options["expiry"] && Date.now() > options["expiry"]) {
    log.info("Token expired, refreshing", {
      providerID: provider.id,
      expiry: new Date(options["expiry"]).toISOString(),
    })
    const result = await fetchToken()
    if (!result) throw new Error("Failed to fetch token for refresh")
    const { apiKey, expiry } = result
    options["headers"] = { ...(options["headers"] || {}), "api-key": apiKey }
    options["expiry"] = expiry
    // persist back to provider state
    await applyTokenToProvider(provider.id, stateGetter, apiKey, expiry)
    log.info("Token refreshed", { providerID: provider.id, newExpiry: new Date(expiry).toISOString() })
  }

  const originalFetch = options["fetch"] ?? fetch
  options["fetch"] = createFetchWrapper(provider.id, stateGetter, originalFetch)
  // No return: this function mutates `options` in-place.
}

export async function handleReactiveAuthError(providerID: string, stateGetter: () => Promise<any>) {
  log.info("Handling reactive auth error, attempting token refresh", { providerID })
  const result = await fetchToken()
  if (!result) throw new Error("Failed to fetch token for refresh")
  const { apiKey, expiry } = result
  const applied = await applyTokenToProvider(providerID, stateGetter, apiKey, expiry)
  if (!applied) {
    throw new Error("No provider found for reactive refresh")
  }
}
