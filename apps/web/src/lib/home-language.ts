export const LANGUAGE_COOKIE = 'agentjob_language'

export function preferredHomeLanguage(preference?: string, country?: string | null): 'en' | 'zh' {
  if (preference === 'en' || preference === 'zh') return preference
  return ['CN', 'HK', 'TW', 'SG'].includes(country?.toUpperCase() ?? '') ? 'zh' : 'en'
}
