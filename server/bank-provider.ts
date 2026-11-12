import type { CanonicalTransactionInput } from "./ingestion.ts";

export interface BankInstitution { id: string; name: string; countries: string[]; transactionTotalDays: number | null }
export interface BankAuthorization {
  id: string; status: string; accounts: string[]; link: string | null;
  institutionId: string; reference: string | null;
  expiresAt?: string;
  accountIdentities?: Record<string, string>;
}
export interface BankProviderClient {
  readonly providerId?: string;
  listItalianInstitutions(): Promise<BankInstitution[]>;
  createRequisition(institutionId: string, redirect: string, state: string): Promise<BankAuthorization>;
  exchangeAuthorization?(code: string): Promise<BankAuthorization>;
  getRequisition(id: string): Promise<BankAuthorization>;
  deleteRequisition(id: string): Promise<void>;
  getAccount(id: string): Promise<{ id: string; status: string; name: string | null; iban: string | null }>;
  getBalances(id: string): Promise<{ amountCents: number; type: string; referenceDate: string | null }[]>;
  getTransactions(id: string, dates?: { from: string; to: string }): Promise<CanonicalTransactionInput[]>;
}

/** Fixed public codes only; never attach provider error bodies, URLs or tokens. */
export class BankProviderError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Bank data request failed (${status}, ${code})`); }
}
