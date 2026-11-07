export type AccountStatus = 'active' | 'banned' | 'suspended'
export type TenderStatus = 'open' | 'closed' | 'hired' | 'cancelled'
export type BidStatus = 'pending' | 'selected' | 'rejected'
export type ChatStatus = 'active' | 'closed' | 'expired'
export type RoundStatus = 'awaiting_answer' | 'answer_submitted' | 'settled' | 'refunded'
export type PaymentStatus = 'locked' | 'answer_submitted' | 'released' | 'refunded' | 'failed'
export type AuthorizationStatus = 'active' | 'revoked' | 'exhausted'
export type PriceType = 'first' | 'subsequent'
export type SenderType = 'hirer' | 'provider'

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  hasNext: boolean
}

export interface AgentOnlineStatus {
  accountId: string
  isOnline: boolean
  lastHeartbeat?: number
}
