/** @jsxImportSource https://esm.sh/react@18.2.0 */
import { useEffect, useState } from "https://esm.sh/react@18.2.0";
import type { ChangeEvent } from "https://esm.sh/react@18.2.0";
import type { Account } from "../../shared/types.ts";
import type { CsvColumnMapping } from "../../server/ingestion.ts";

type Profile = { id: string; name: string; mapping: CsvColumnMapping };
type Preview = { headers: string[]; rowCount?: number; validCount?: number; sample?: Array<{ occurredOn: string; amountCents: number; description: string }>; rowErrors?: Array<{ sourcePosition: number; summary: string }> };
const emptyMapping: CsvColumnMapping = { date: "", amount: "", description: "" };

export function CsvImport({ accounts, onImported }: { accounts: Account[]; onImported: () => Promise<void> }) {
  const [filename, setFilename] = useState("");
  const [csv, setCsv] = useState("");
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [mapping, setMapping] = useState<CsvColumnMapping>(emptyMapping);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const request = async <T,>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-BudgetApp-Request": "1" }, body: body == null ? undefined : JSON.stringify(body) });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(result?.error ?? result?.errors?.join("; ") ?? `Request failed (${response.status})`);
    return result as T;
  };
  const reloadProfiles = async () => setProfiles((await request<{ profiles: Profile[] }>("/api/imports/csv/profiles")).profiles);
  useEffect(() => { void reloadProfiles().catch((error) => setMessage(String(error))); }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreview(null); setFilename(file.name);
    if (file.size > 500_000) { setMessage("CSV file is too large"); return; }
    const content = await file.text(); setCsv(content);
    await run(async () => {
      const result = await request<Preview>("/api/imports/csv/preview", "POST", { csv: content });
      setPreview(result);
      const headers = result.headers;
      const match = (...names: string[]) => headers.find((header) => names.includes(header.toLowerCase())) ?? "";
      if (!profileId) setMapping({ date: match("date", "data"), amount: match("amount", "importo"), description: match("description", "descrizione"), debit: match("debit", "addebito"), credit: match("credit", "accredito") });
    });
  };
  const setColumn = (key: keyof CsvColumnMapping, value: string) => { setMapping((previous) => ({ ...previous, [key]: value || undefined })); setPreview((previous) => previous && { headers: previous.headers }); };
  const column = (key: keyof CsvColumnMapping, label: string) => <label className="text-sm">{label}<select className="mt-1 block w-full rounded-lg border border-stone-300 p-2" value={mapping[key] ?? ""} onChange={(event) => setColumn(key, event.target.value)}><option value="">Select column</option>{preview?.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>;
  return <section className="mb-6 rounded-2xl border border-stone-200 bg-white p-4 sm:p-5">
    <h2 className="font-semibold">Import bank CSV</h2><p className="mt-1 text-sm text-stone-500">Preview all rows before importing. Invalid rows block the entire file.</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm">Account<select className="mt-1 block w-full rounded-lg border border-stone-300 p-2" value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label className="text-sm">CSV file<input className="mt-1 block w-full text-sm" type="file" accept=".csv,text/csv" onChange={(event) => { void loadFile(event); }} /></label></div>
    {preview && <><div className="mt-4 grid gap-3 sm:grid-cols-3"><label className="text-sm">Saved profile<select className="mt-1 block w-full rounded-lg border border-stone-300 p-2" value={profileId} onChange={(event) => { const selected = profiles.find((profile) => profile.id === event.target.value); setProfileId(selected?.id ?? ""); setProfileName(selected?.name ?? ""); if (selected) setMapping(selected.mapping); setPreview({ headers: preview.headers }); }}><option value="">New mapping</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>{column("date", "Date")}{column("description", "Description")}{column("amount", "Signed amount (or debit + credit)")}{column("debit", "Debit")}{column("credit", "Credit")}{column("externalId", "Bank transaction ID (optional)")}{column("status", "Status (optional)")}<label className="text-sm">Date format<select className="mt-1 block w-full rounded-lg border border-stone-300 p-2" value={mapping.dateFormat ?? ""} onChange={(event) => setColumn("dateFormat", event.target.value)}><option value="">Auto (ISO or DD/MM/YYYY)</option><option value="iso">YYYY-MM-DD</option><option value="day_first">DD/MM/YYYY</option><option value="month_first">MM/DD/YYYY</option></select></label><label className="text-sm">Decimal separator<select className="mt-1 block w-full rounded-lg border border-stone-300 p-2" value={mapping.decimalSeparator ?? ","} onChange={(event) => setColumn("decimalSeparator", event.target.value)}><option value=",">Comma (1.234,56)</option><option value=".">Period (1,234.56)</option></select></label></div>
      <div className="mt-4 flex flex-wrap items-end gap-2"><label className="text-sm">Profile name<input className="mt-1 block rounded-lg border border-stone-300 p-2" value={profileName} maxLength={80} onChange={(event) => setProfileName(event.target.value)} /></label><button disabled={busy || !profileName} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={() => { void run(async () => { const result = await request<{ id: string }>(profileId ? `/api/imports/csv/profiles/${profileId}` : "/api/imports/csv/profiles", profileId ? "PUT" : "POST", { name: profileName, mapping }); if (!profileId) setProfileId(result.id); await reloadProfiles(); setMessage("Profile saved"); }); }}>Save profile</button>{profileId && <button disabled={busy} className="rounded-lg border px-3 py-2 text-sm" onClick={() => { void run(async () => { await request(`/api/imports/csv/profiles/${profileId}`, "DELETE"); setProfileId(""); setProfileName(""); await reloadProfiles(); setMessage("Profile deleted"); }); }}>Delete profile</button>}</div>
      <div className="mt-4 flex gap-2"><button disabled={busy || !csv} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={() => { void run(async () => setPreview(await request<Preview>("/api/imports/csv/preview", "POST", { csv, mapping }))); }}>Preview rows</button><button disabled={busy || preview.rowCount == null || Boolean(preview.rowErrors?.length) || !preview.validCount} className="rounded-lg bg-green-900 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => { void run(async () => { const result = await request<{ importedCount: number; duplicateCount: number; ambiguousCount: number }>("/api/imports/csv", "POST", { accountId, filename, csv, mapping }); setMessage(`Imported ${result.importedCount}; ${result.duplicateCount} duplicates; ${result.ambiguousCount} ambiguous.`); await onImported(); }); }}>Import {preview.validCount ?? 0} rows</button></div>
      {preview.rowCount != null && <div className="mt-3 text-sm"><p>{preview.validCount} valid of {preview.rowCount} rows</p>{preview.sample?.map((row, index) => <p key={index} className="truncate text-stone-600">{row.occurredOn} · {(row.amountCents / 100).toFixed(2)} € · {row.description}</p>)}{preview.rowErrors?.map((error) => <p key={error.sourcePosition} className="text-red-700">Row {error.sourcePosition}: {error.summary}</p>)}</div>}
    </>}{message && <p role="status" className="mt-3 text-sm text-stone-700">{message}</p>}
  </section>;
}
