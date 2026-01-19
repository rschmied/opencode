import { describe, expect, test, beforeEach } from "bun:test"
import * as Circuit from "@/provider/circuit"

// Helper to create mutable state object used by stateGetter
function createStateWithProvider(providerID: string, apiKey?: string) {
  const state = {
    providers: {},
  } as any
  state.providers[providerID] = {
    options: {
      headers: apiKey ? { "api-key": apiKey } : {},
    },
  }
  return state
}

describe("provider/circuit", () => {
  beforeEach(() => {
    // clear env keys that might interfere
    delete process.env.CIRCUIT_API_KEY
    delete process.env.CIRCUIT_CLIENT_ID
    delete process.env.CIRCUIT_CLIENT_SECRET
    delete process.env.CIRCUIT_APP_KEY
    delete process.env.CIRCUIT_APP_USER
  })

  test("buildUserString uses env vars", () => {
    process.env.CIRCUIT_APP_KEY = "app-123"
    process.env.CIRCUIT_APP_USER = " alice "
    const s = Circuit.buildUserString()
    expect(typeof s).toBe("string")
    const parsed = JSON.parse(s)
    expect(parsed.appkey).toBe("app-123")
    expect(parsed.user).toBe("alice")
  })

  test("fetchToken returns static api key when CIRCUIT_API_KEY set", async () => {
    process.env.CIRCUIT_API_KEY = "static-xyz"
    const res = await Circuit.fetchToken()
    expect(res).not.toBeNull()
    expect(res?.apiKey).toBe("static-xyz")
    expect(typeof res?.expiry).toBe("number")
  })

  test("createFetchWrapper attaches api-key and compacts gemini tools", async () => {
    const pid = "test-provider"
    const state = createStateWithProvider(pid, "OLDKEY")
    const stateGetter = async () => state

    let capturedInit: any = null
    const originalFetch = async (input: any, init?: any) => {
      capturedInit = init
      return { status: 200 }
    }

    const wrapper = Circuit.createFetchWrapper(pid, stateGetter, originalFetch as any)

    const body = JSON.stringify({
      tools: [
        { type: "tool", function: { name: "fn", parameters: { properties: { a: { type: "string" } }, required: [] } } },
      ],
    })

    await wrapper("https://api.gemini.example/v1", { headers: { "Content-Type": "application/json" }, body })

    expect(capturedInit).not.toBeNull()
    expect(capturedInit.headers["api-key"]).toBe("OLDKEY")
    const parsed = JSON.parse(capturedInit.body)
    expect(Array.isArray(parsed.tools)).toBe(true)
    expect(parsed.tools[0].function.parameters.properties.a.type).toBe("string")
  })

  test("createFetchWrapper refreshes token on 401 and retries with new key", async () => {
    const pid = "test-provider-2"
    const state = createStateWithProvider(pid, "BEFORE")
    const stateGetter = async () => state

    let callCount = 0
    const originalFetch = async (input: any, init?: any) => {
      callCount++
      if (callCount === 1) return { status: 401 }
      return { status: 200 }
    }

    // Use a static env key so fetchToken() will return the new key during refresh
    process.env.CIRCUIT_API_KEY = "AFTER"

    const wrapper = Circuit.createFetchWrapper(pid, stateGetter, originalFetch as any)
    const res = await wrapper("https://example.com", { headers: {} })
    expect(res).not.toBeNull()
    expect(state.providers[pid].options.headers["api-key"]).toBe("AFTER")
    // ensure originalFetch was called at least twice (initial + retry)
    expect(callCount).toBeGreaterThanOrEqual(2)
  })
})
