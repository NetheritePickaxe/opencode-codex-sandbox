import crypto from "node:crypto"

export interface PrivateDesktop {
  name: string
  close(): void
}

const DESKTOP_PREFIX = "CodexSandboxDesktop-"
// DESKTOP_ALL_ACCESS: specific desktop rights (0x1FF) | STANDARD_RIGHTS_REQUIRED (0xF0000)
const DESKTOP_ALL_ACCESS = 0x000f01ff
const TOKEN_QUERY = 0x0008
const TOKEN_LOGON_SID_CLASS = 28
let structSeq = 0

function wide(s: string): Buffer {
  return Buffer.from(s + "\0", "utf16le")
}

// The logon SID (S-1-5-5-x-y) is not exposed by whoami or WindowsIdentity.Groups;
// read it straight from the process token via GetTokenInformation(TokenLogonSid).
function getLogonSid(koffi: any, advapi32: any, kernel32: any): string {
  const OpenProcessToken = advapi32.func(
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
  )
  const GetTokenInformation = advapi32.func(
    "int __stdcall GetTokenInformation(void *token, uint32_t infoClass, void *info, uint32_t len, _Out_ uint32_t *retLen)",
  )
  const GetCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()")
  const CloseHandle = kernel32.func("int __stdcall CloseHandle(void *handle)")
  const SID_AND_ATTRIBUTES = koffi.struct({ Sid: "void *", Attributes: "uint32_t" })
  const TOKEN_LOGON_SID = koffi.struct({ SidCount: "uint32_t", Sids: koffi.array(SID_AND_ATTRIBUTES, 1) })

  const tokenOut: unknown[] = [null]
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, tokenOut)) {
    throw new Error("opencode-codex-sandbox: OpenProcessToken failed")
  }
  const token = tokenOut[0]
  try {
    const buf = Buffer.alloc(512)
    const retLen: number[] = [0]
    if (!GetTokenInformation(token, TOKEN_LOGON_SID_CLASS, buf, buf.length, retLen)) {
      throw new Error("opencode-codex-sandbox: GetTokenInformation(TokenLogonSid) failed")
    }
    const info = koffi.decode(buf, TOKEN_LOGON_SID)
    if (info.SidCount < 1) throw new Error("opencode-codex-sandbox: token has no logon SID")
    const sidPtr = info.Sids[0].Sid
    const head: number[] = koffi.decode(sidPtr, koffi.array("uint8_t", 8))
    const subAuthorityCount = head[1]
    const bytes: number[] = koffi.decode(sidPtr, koffi.array("uint8_t", 8 + 4 * subAuthorityCount))
    let authority = 0
    for (let i = 2; i < 8; i++) authority = authority * 256 + bytes[i]
    const subs: string[] = []
    for (let i = 0; i < subAuthorityCount; i++) {
      const o = 8 + 4 * i
      subs.push(String(((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0)))
    }
    return `S-${head[0]}-${authority}-${subs.join("-")}`
  } finally {
    CloseHandle(token)
  }
}

// Creates a private desktop and keeps its handle open for the plugin lifetime.
// The codex wrapper only OpenDesktopW's an existing desktop; the last closed
// handle destroys it, so the handle must outlive every sandboxed command.
export async function createPrivateDesktop(): Promise<PrivateDesktop> {
  const koffi = (await import("koffi")).default
  const user32 = koffi.load("user32.dll")
  const advapi32 = koffi.load("advapi32.dll")
  const kernel32 = koffi.load("kernel32.dll")

  const saTypeName = `SBX_SECURITY_ATTRIBUTES_${++structSeq}`
  const SECURITY_ATTRIBUTES = koffi.struct(saTypeName, {
    nLength: "uint32_t",
    lpSecurityDescriptor: "void *",
    bInheritHandle: "int32_t",
  })
  const CreateDesktopW = user32.func(
    `void * __stdcall CreateDesktopW(const void *name, const void *device, void *devmode, uint32_t flags, uint32_t access, ${saTypeName} *sa)`,
  )
  const CloseDesktop = user32.func("int __stdcall CloseDesktop(void *handle)")
  const ConvertStringSecurityDescriptorToSecurityDescriptorW = advapi32.func(
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const void *sddl, uint32_t revision, _Out_ void **sd, void *size)",
  )
  const LocalFree = kernel32.func("void * __stdcall LocalFree(void *ptr)")
  const GetLastError = kernel32.func("uint32_t __stdcall GetLastError()")

  const logonSid = getLogonSid(koffi, advapi32, kernel32)
  // Grant the logon SID full desktop access: both the wrapper process and the
  // restricted-token child carry this SID (mirrors codex grant_desktop_access).
  const sddl = `D:(A;;0x${DESKTOP_ALL_ACCESS.toString(16)};;;${logonSid})`
  const sdOut: unknown[] = [null]
  const ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, sdOut, null)
  if (!ok) throw new Error(`opencode-codex-sandbox: ConvertStringSecurityDescriptorToSecurityDescriptorW failed: ${GetLastError()}`)
  const sd = sdOut[0]

  const name = DESKTOP_PREFIX + crypto.randomBytes(16).toString("hex")
  const sa = { nLength: koffi.sizeof(SECURITY_ATTRIBUTES), lpSecurityDescriptor: sd, bInheritHandle: 0 }
  const handle = CreateDesktopW(wide(name), null, null, 0, DESKTOP_ALL_ACCESS, sa)
  LocalFree(sd)
  if (!handle) {
    throw new Error(`opencode-codex-sandbox: CreateDesktopW failed: ${GetLastError()}`)
  }

  let closed = false
  return {
    name,
    close() {
      if (!closed) {
        closed = true
        CloseDesktop(handle)
      }
    },
  }
}