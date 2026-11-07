export type LoginStage = 'SEND' | 'VERIFY' | 'WALLET' | 'TOKEN' | 'SYNC' | 'SESSION'
export type LoginDiagnostic = { code:string; stage:LoginStage; at:string; elapsedMs:number; httpStatus?:number; message:string }
export function loginDiagnostic(stage:LoginStage, elapsedMs:number, failure?:unknown):LoginDiagnostic {
  const e=failure as {message?:unknown;name?:unknown;status?:unknown;statusCode?:unknown;response?:{status?:unknown}} | undefined
  const raw=typeof e?.message==='string'?e.message:''
  const status=e?.status??e?.statusCode??e?.response?.status
  const httpStatus=typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?status:undefined
  const kind=failure===undefined?'OK':httpStatus===429?'RATE_LIMIT':httpStatus===401||httpStatus===403?'REJECTED':httpStatus&&httpStatus>=500?'SERVER':
    /timeout|timed? out|in time/i.test(raw)||e?.name==='TimeoutError'?'TIMEOUT':
    /failed to fetch|network|load failed|fetch failed/i.test(raw)?'NETWORK':
    stage==='VERIFY'&&/incorrect.*otp|invalid.*otp|expired.*otp|otp.*expired|incorrect.*code|invalid.*code/i.test(raw)?'OTP_REJECTED':httpStatus?'HTTP':'FAILED'
  const hints:Record<string,string>={OK:'Completed.',RATE_LIMIT:'Too many requests. Wait before trying again.',REJECTED:'The sign-in service rejected this step. Copy diagnostics for support.',SERVER:'The service returned an error. Copy diagnostics and try again later.',TIMEOUT:'This step timed out. The request may still be processing; avoid repeated code requests.',NETWORK:'The browser could not reach the service. Check your connection and copy diagnostics.',OTP_REJECTED:'Code not accepted. Use the latest code requested in this tab.',HTTP:'The service returned an unsuccessful response. Copy diagnostics for support.',FAILED:'This step could not be completed. Copy diagnostics for support.'}
  return {code:`LOGIN_${stage}_${kind}`,stage,at:new Date().toISOString(),elapsedMs:Math.max(0,Math.round(elapsedMs)),...(httpStatus?{httpStatus}:{}),message:hints[kind]}
}
