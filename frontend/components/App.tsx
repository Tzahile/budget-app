/** @jsxImportSource https://esm.sh/react@18.2.0 */
import { useCallback, useEffect, useMemo, useState } from "https://esm.sh/react@18.2.0";
import type { ButtonHTMLAttributes, FormEvent, ReactNode } from "https://esm.sh/react@18.2.0";
import { canCleanupDemoData, DEMO_CLEANUP_CONFIRMATION, type Account, type AppData, type PlannedCompletion, type PlannedTransaction, type Reserve, type Transaction } from "../../shared/types.ts";
import { householdDate } from "../../shared/finance.ts";

type View = "overview" | "activity" | "planned" | "reserves" | "accounts";
type Editor =
  | { type: "account"; item?: Account }
  | { type: "transaction"; item?: Transaction }
  | { type: "transfer"; item?: Transaction }
  | { type: "planned"; item?: PlannedTransaction }
  | { type: "reserve"; item?: Reserve }
  | { type: "correction"; item: PlannedCompletion }
  | { type: "reconciliation"; item: Account }
  | null;

interface Session {
  authenticated: boolean;
  authorized: boolean;
  username?: string;
}

const nav: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "planned", label: "Planned" },
  { id: "reserves", label: "Reserves" },
  { id: "accounts", label: "Accounts" },
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<AppData | null>(null);
  const [view, setView] = useState<View>("overview");
  const [editor, setEditor] = useState<Editor>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const nextSession = await api<Session>("/api/session", undefined, false);
    setSession(nextSession);
    if (nextSession.authorized) setData(await api<AppData>("/api/data"));
  }, []);

  useEffect(() => {
    load().catch((err) => setError(messageOf(err)));
  }, [load]);

  const mutate = useCallback(async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try {
      await api(path, { method, body: body == null ? undefined : JSON.stringify(body) });
      setEditor(null);
      setData(await api<AppData>("/api/data"));
    } catch (err) {
      setError(messageOf(err));
      throw err;
    } finally {
      setBusy(false);
    }
  }, []);

  const cleanupDemo = useCallback(() => {
    const confirmation = window.prompt(`Type ${DEMO_CLEANUP_CONFIRMATION} exactly to permanently remove all synthetic demo data.`);
    if (confirmation == null) return;
    if (confirmation !== DEMO_CLEANUP_CONFIRMATION) {
      setError(`Confirmation did not match ${DEMO_CLEANUP_CONFIRMATION}. Nothing was removed.`);
      return;
    }
    void mutate("/api/demo", "DELETE", { confirmation }).catch(() => undefined);
  }, [mutate]);

  if (!session) return <Centered><Spinner label="Opening your budget…" /></Centered>;
  if (!session.authenticated) {
    return (
      <Centered>
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-xl border border-stone-200">
          <Brand />
          <h1 className="mt-10 text-3xl font-semibold tracking-tight">Know what is safe to spend.</h1>
          <p className="mt-3 text-stone-500 leading-relaxed">A private household cash-flow view. Your data stays behind your Val Town account.</p>
          <a href="/auth/login" className="mt-8 block rounded-xl bg-green-900 px-5 py-3 text-center font-medium text-white hover:bg-green-800">Log in with Val Town</a>
        </div>
      </Centered>
    );
  }
  if (!session.authorized) {
    return <Centered><div className="max-w-md text-center"><Brand /><h1 className="mt-8 text-2xl font-semibold">Account not authorized</h1><p className="mt-2 text-stone-500">Signed in as {session.username}. Only the app owner and explicitly allowed family accounts can access this data.</p><Logout /></div></Centered>;
  }
  if (!data) return <Centered><Spinner label="Calculating cash flow…" /></Centered>;

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="sticky top-0 z-20 border-b border-stone-200 bg-stone-50 bg-opacity-95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Brand />
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-stone-500 sm:block">{session.username}</span>
            <Logout compact />
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-3 sm:px-5" aria-label="Budget sections">
          {nav.map((item) => (
            <button key={item.id} onClick={() => setView(item.id)} className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors ${view === item.id ? "border-green-800 text-green-900" : "border-transparent text-stone-500 hover:text-stone-900"}`}>
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 pb-20 sm:px-6 sm:py-10">
        {error && <div role="alert" className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss">×</button></div>}
        {data.accounts.length === 0 ? (
          <EmptyStart
            busy={busy}
            canCleanupDemo={canCleanupDemoData(data.demoDataState)}
            onDemo={() => mutate("/api/demo", "POST")}
            onAccount={() => setEditor({ type: "account" })}
            onCleanupDemo={cleanupDemo}
          />
        ) : view === "overview" ? (
          <Overview
            data={data}
            onAddTransaction={() => setEditor({ type: "transaction" })}
            onAddPlanned={() => setEditor({ type: "planned" })}
            onCleanupDemo={cleanupDemo}
            onNavigate={setView}
          />
        ) : view === "activity" ? (
          <Activity data={data} onAdd={() => setEditor({ type: "transaction" })} onAddTransfer={() => setEditor({ type: "transfer" })} onEdit={(item) => setEditor(item.kind === "transfer" ? { type: "transfer", item } : { type: "transaction", item })} onDelete={(item) => item.kind === "transfer"
            ? confirmed("Delete this linked transfer and reverse both account effects?") && mutate(`/api/transfers/${item.transferGroupId}`, "DELETE")
            : confirmed("Delete this transaction and reverse its balance effect?") && mutate(`/api/transactions/${item.id}`, "DELETE")} />
        ) : view === "planned" ? (
          <Planned data={data} onAdd={() => setEditor({ type: "planned" })} onEdit={(item) => setEditor({ type: "planned", item })} onComplete={(item) => mutate(`/api/planned/${item.id}/complete`, "POST", { date: today(), accountId: item.accountId ?? data.accounts[0]?.id })} onUndo={(item) => confirmed("Undo this completion and restore the unpaid occurrence?") && mutate(`/api/planned-completions/${item.id}/undo`, "POST", { expectedEffectiveTransactionId: item.effectiveTransaction!.id })} onCorrect={(item) => setEditor({ type: "correction", item })} onDeactivate={(id) => confirmed("Deactivate this planned item while preserving its history?") && mutate(`/api/planned/${id}/deactivate`, "POST")} onDelete={(id) => confirmed("Delete this planned item?") && mutate(`/api/planned/${id}`, "DELETE")} />
        ) : view === "reserves" ? (
          <Reserves data={data} onAdd={() => setEditor({ type: "reserve" })} onEdit={(item) => setEditor({ type: "reserve", item })} onDelete={(id) => confirmed("Delete this reserve?") && mutate(`/api/reserves/${id}`, "DELETE")} />
        ) : (
          <Accounts data={data} onAdd={() => setEditor({ type: "account" })} onEdit={(item) => setEditor({ type: "account", item })} onReconcile={(item) => setEditor({ type: "reconciliation", item })} onDelete={(id) => confirmed("Delete this empty account?") && mutate(`/api/accounts/${id}`, "DELETE")} />
        )}
      </main>

      {editor && (
        <EditorModal editor={editor} data={data} busy={busy} onClose={() => setEditor(null)} onSave={async (payload) => {
          const item = editor.item;
          if (editor.type === "correction") {
            await mutate(`/api/planned-completions/${editor.item.id}/correct`, "POST", {
              ...(payload as Record<string, unknown>),
              expectedEffectiveTransactionId: editor.item.effectiveTransaction!.id,
            });
            return;
          }
          if (editor.type === "reconciliation") {
            await mutate(`/api/accounts/${editor.item.id}/reconcile`, "POST", payload);
            return;
          }
          const base = editor.type === "transaction" ? "/api/transactions" : editor.type === "transfer" ? "/api/transfers" : editor.type === "planned" ? "/api/planned" : editor.type === "reserve" ? "/api/reserves" : "/api/accounts";
          const id = editor.type === "transfer" ? (item as Transaction | undefined)?.transferGroupId : item?.id;
          await mutate(id ? `${base}/${id}` : base, id ? "PUT" : "POST", payload);
        }} />
      )}
      <footer className="mx-auto max-w-6xl px-6 pb-8 text-center text-xs text-stone-400"><a className="hover:text-stone-600" href="/source">View source</a></footer>
    </div>
  );
}

function Overview({ data, onAddTransaction, onAddPlanned, onCleanupDemo, onNavigate }: { data: AppData; onAddTransaction: () => void; onAddPlanned: () => void; onCleanupDemo: () => void; onNavigate: (view: View) => void }) {
  const d = data.dashboard;
  return (
    <div>
      {data.demoDataState === "demo-only" && (
        <div className="mb-6 flex flex-col justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 sm:flex-row sm:items-center">
          <div><p className="font-medium text-amber-950">Synthetic demo data</p><p className="mt-1 text-sm text-amber-800">This dataset contains demo records only. Cleanup permanently removes all of them.</p></div>
          <Button secondary onClick={onCleanupDemo}>Remove demo data</Button>
        </div>
      )}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-sm font-medium text-stone-500">HOUSEHOLD CASH FLOW</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">Your money this month</h1><p className="mt-2 text-sm text-stone-500">As of {prettyDate(d.asOfDate)}</p></div>
        <div className="flex gap-2"><Button secondary onClick={onAddPlanned}>Plan ahead</Button><Button onClick={onAddTransaction}>Add transaction</Button></div>
      </div>

      <section className={`mt-7 overflow-hidden rounded-3xl p-6 text-white shadow-lg sm:p-8 ${d.availableToSpendCents < 0 ? "bg-red-900" : "bg-green-950"}`}>
        <p className="text-sm font-medium uppercase tracking-widest text-green-100">Available to spend</p>
        <p className="mt-3 text-5xl font-semibold tracking-tight sm:text-6xl">{money(d.availableToSpendCents)}</p>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-green-100">Deterministic: cash now, plus expected income, minus unpaid commitments and protected reserves through {prettyDate(d.monthEnd)}. This is not spending advice.</p>
      </section>

      <AvailabilityBreakdown data={data} onNavigate={onNavigate} />

      <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Cash now" value={d.currentCashCents} />
        <Metric label="Spent this month" value={d.spentThisMonthCents} />
        <Metric label="Still coming in" value={d.remainingIncomeCents} positive />
        <Metric label="Still committed" value={d.remainingExpensesCents} negative />
      </section>

      <div className="mt-7 grid gap-5 lg:grid-cols-3">
        <section className="rounded-2xl border border-stone-200 bg-white p-5 lg:col-span-2">
          <SectionTitle title="Upcoming this month" subtitle={`${d.upcoming.length} expected item${d.upcoming.length === 1 ? "" : "s"}`} />
          <div className="mt-4 divide-y divide-stone-100">
            {d.upcoming.length === 0 ? <EmptyLine>Nothing else is planned this month.</EmptyLine> : d.upcoming.slice(0, 8).map((item, index) => (
              <div key={`${item.plannedTransactionId}-${item.date}-${index}`} className="flex items-center gap-3 py-3">
                <DateBadge date={item.date} />
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{item.description}</p><p className="text-xs text-stone-400"><span className="capitalize">{item.kind}</span>{item.linkedGoalCoverageCents > 0 ? ` · ${money(item.linkedGoalCoverageCents)} covered by ${item.linkedReserveName}` : ""}</p></div>
                <Amount cents={item.kind === "expense" ? -item.amountCents : item.amountCents} />
              </div>
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-stone-200 bg-white p-5">
          <SectionTitle title="Month-end view" />
          <div className="mt-5 space-y-4">
            <SummaryRow label="Projected balance" cents={d.projectedMonthEndCents} strong />
            <SummaryRow label="Already protected" cents={-d.fundedReservesCents} />
            {d.requiredGoalContributionsCents > 0 && <SummaryRow label="Still to protect for goals this month" cents={-d.requiredGoalContributionsCents} />}
            {d.linkedGoalCoverageCents > 0 && <SummaryRow label="Already counted in planned expenses" cents={d.linkedGoalCoverageCents} />}
            <div className="border-t border-stone-200 pt-4"><SummaryRow label="Available to spend" cents={d.availableToSpendCents} strong /></div>
          </div>
        </section>
      </div>
      <section className="mt-7 rounded-2xl border border-stone-200 bg-white p-5">
        <SectionTitle title="Six-month cash-flow projection" subtitle="Deterministic planned income, commitments, and reserve protection. It is not advisory guidance." />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {d.projectionMonths.map((month) => (
            <div key={month.monthStart} className="rounded-xl border border-stone-100 bg-stone-50 p-4">
              <p className="font-semibold">{prettyMonth(month.monthStart)}</p>
              <div className="mt-3 space-y-2 text-sm">
                <SummaryRow label="Opening cash" cents={month.openingCashCents} />
                <SummaryRow label="Expected income" cents={month.expectedIncomeCents} />
                <SummaryRow label="Committed expenses" cents={-month.committedExpensesCents} />
                {month.monthlyGoalContributionsCents > 0 && <SummaryRow label="Goal protection added" cents={-month.monthlyGoalContributionsCents} />}
                <div className="border-t border-stone-200 pt-2"><SummaryRow label="Projected month-end" cents={month.projectedMonthEndCents} strong /></div>
                <SummaryRow label="Available after reserves" cents={month.availableToSpendCents} strong />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AvailabilityBreakdown({ data, onNavigate }: { data: AppData; onNavigate: (view: View) => void }) {
  const d = data.dashboard;
  const linkedOccurrences = d.upcoming.filter((item) => item.linkedGoalCoverageCents > 0);
  const traceLink = (label: string, view: View) => <button type="button" onClick={() => onNavigate(view)} className="text-left text-xs font-medium text-green-800 underline decoration-green-300 underline-offset-2 hover:text-green-950">{label}</button>;

  return (
    <details className="mt-5 rounded-2xl border border-stone-200 bg-white p-5">
      <summary className="cursor-pointer list-none font-semibold marker:content-none">
        <span className="flex items-center justify-between gap-4">How available to spend is calculated <span className="text-sm font-normal text-stone-500">Details</span></span>
      </summary>
      <p className="mt-4 text-sm leading-relaxed text-stone-600">This is a traceable accounting derivation through {prettyDate(d.monthEnd)}. It does not estimate discretionary spending or give advice.</p>
      <div className="mt-5 divide-y divide-stone-100 rounded-xl border border-stone-100">
        <BreakdownRow label="Cash now" amount={d.currentCashCents} operator="=" source={traceLink(`${data.accounts.filter((account) => account.isActive).length} active account${data.accounts.filter((account) => account.isActive).length === 1 ? "" : "s"}`, "accounts")}>
          {data.accounts.filter((account) => account.isActive).map((account) => <SourceLine key={account.id} label={account.name} amount={account.balanceCents} />)}
        </BreakdownRow>
        <BreakdownRow label="Expected income" amount={d.remainingIncomeCents} operator="+" source={traceLink("View planned cash flow", "planned")}>
          {d.upcoming.filter((item) => item.kind === "income").map((item, index) => <SourceLine key={`${item.plannedTransactionId}-${item.date}-${index}`} label={`${item.description} · ${prettyDate(item.date)}`} amount={item.amountCents} />)}
        </BreakdownRow>
        <BreakdownRow label="Unpaid commitments" amount={d.remainingExpensesCents} operator="−" source={traceLink("View planned cash flow", "planned")}>
          {d.upcoming.filter((item) => item.kind === "expense").map((item, index) => <SourceLine key={`${item.plannedTransactionId}-${item.date}-${index}`} label={`${item.description} · ${prettyDate(item.date)}`} amount={-item.amountCents} />)}
        </BreakdownRow>
        <BreakdownRow label="Protected reserves and goals" amount={d.protectedReservesCents} operator="−" source={traceLink("View reserves and goals", "reserves")}>
          <SourceLine label="Funded reserve amounts" amount={-d.fundedReservesCents} />
          {d.requiredGoalContributionsCents > 0 && <SourceLine label="Goal contributions still required this month" amount={-d.requiredGoalContributionsCents} />}
          {d.linkedGoalCoverageCents > 0 && <SourceLine label="Less goal funding already represented by a linked commitment" amount={d.linkedGoalCoverageCents} />}
        </BreakdownRow>
        {linkedOccurrences.length > 0 && <div className="px-4 py-4 text-sm"><p className="font-medium">Linked-goal effect</p><p className="mt-1 text-stone-500">The linked amount is added back once because the full planned expense above already subtracts it. This prevents double counting.</p><div className="mt-3 space-y-2">{linkedOccurrences.map((item, index) => <SourceLine key={`${item.plannedTransactionId}-${item.date}-${index}`} label={`${item.linkedReserveName}: ${item.description} · ${prettyDate(item.date)}`} amount={item.linkedGoalCoverageCents} />)}</div></div>}
        <div className="flex items-center justify-between gap-4 bg-stone-50 px-4 py-4"><span className="font-semibold">Available to spend</span><span className="font-semibold">{money(d.availableToSpendCents)}</span></div>
      </div>
    </details>
  );
}

function BreakdownRow({ label, amount, operator, source, children }: { label: string; amount: number; operator: "=" | "+" | "−"; source: ReactNode; children: ReactNode }) {
  return <div className="px-4 py-4"><div className="flex items-start justify-between gap-4"><div><p className="font-medium">{operator === "=" ? "" : `${operator} `}{label}</p><div className="mt-1">{source}</div></div><span className="font-medium">{operator === "−" ? money(-amount) : money(amount)}</span></div><div className="mt-3 space-y-2 border-l-2 border-stone-100 pl-3">{children}</div></div>;
}

function SourceLine({ label, amount }: { label: string; amount: number }) {
  return <div className="flex items-center justify-between gap-4 text-xs text-stone-500"><span className="min-w-0 truncate">{label}</span><span className="shrink-0">{money(amount)}</span></div>;
}

function Activity({ data, onAdd, onAddTransfer, onEdit, onDelete }: { data: AppData; onAdd: () => void; onAddTransfer: () => void; onEdit: (item: Transaction) => void; onDelete: (item: Transaction) => void }) {
  const accounts = useMemo(() => Object.fromEntries(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const activity = useMemo(() => data.transactions.filter((item) => item.kind !== "transfer" || item.amountCents < 0), [data.transactions]);
  const transferTargets = useMemo(() => Object.fromEntries(data.transactions.filter((item) => item.kind === "transfer" && item.amountCents > 0).map((item) => [item.transferGroupId!, item])), [data.transactions]);
  return <Page title="Activity" subtitle="Income and expenses change balances; transfers move money between your own accounts." action="Add transaction" onAction={onAdd}><div className="mb-3 flex justify-end"><SmallButton onClick={onAddTransfer}>Transfer between accounts</SmallButton></div><div className="divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white px-4 sm:px-5">{activity.length === 0 ? <EmptyLine>No transactions yet.</EmptyLine> : activity.map((item) => { const target = item.transferGroupId ? transferTargets[item.transferGroupId] : undefined; const transferMeta = target ? `${accounts[item.accountId] ?? "Unknown account"} → ${accounts[target.accountId] ?? "Unknown account"} · transfer` : `${accounts[item.accountId] ?? "Unknown account"} · ${item.source}`; return <ListRow key={item.id} title={item.description} meta={`${prettyDate(item.date)} · ${transferMeta}`} amount={item.amountCents} inactive={item.status === "pending"} onEdit={item.source === "manual" ? () => onEdit(item) : undefined} onDelete={item.source === "manual" ? () => onDelete(item) : undefined} />; })}</div></Page>;
}

function Planned({ data, onAdd, onEdit, onComplete, onUndo, onCorrect, onDeactivate, onDelete }: { data: AppData; onAdd: () => void; onEdit: (item: PlannedTransaction) => void; onComplete: (item: PlannedTransaction) => void; onUndo: (item: PlannedCompletion) => void; onCorrect: (item: PlannedCompletion) => void; onDeactivate: (id: string) => void; onDelete: (id: string) => void }) {
  const accounts = useMemo(() => Object.fromEntries(data.accounts.map((a) => [a.id, a.name])), [data.accounts]);
  const linkedGoals = useMemo(() => Object.fromEntries(data.reserves.filter((reserve) => reserve.linkedPlannedTransactionId).map((reserve) => [reserve.linkedPlannedTransactionId!, reserve.name])), [data.reserves]);
  return <Page title="Planned cash flow" subtitle="Unpaid and overdue occurrences are included until you mark them complete." action="Add planned item" onAction={onAdd}><div className="grid gap-3">{data.plannedTransactions.length === 0 ? <Card><EmptyLine>No planned items yet.</EmptyLine></Card> : data.plannedTransactions.map((item) => { const hasHistory = data.plannedCompletions.some((completion) => completion.plannedTransactionId === item.id); return <div key={item.id} className={`rounded-2xl border bg-white p-4 sm:p-5 ${item.isActive ? "border-stone-200" : "border-stone-100 opacity-60"}`}><div className="flex items-start gap-4"><DateBadge date={item.nextDate} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.description}</h3><Badge>{item.recurrence === "once" ? "One-off" : `Every ${item.intervalCount > 1 ? `${item.intervalCount} ` : ""}${item.recurrence.replace("ly", "")}${item.intervalCount > 1 ? "s" : ""}`}</Badge>{linkedGoals[item.id] && <Badge>Linked to {linkedGoals[item.id]}</Badge>}{!item.isActive && <Badge>Inactive</Badge>}</div><p className="mt-1 text-sm text-stone-500">Next: {prettyDate(item.nextDate)}</p></div><Amount cents={item.kind === "expense" ? -item.amountCents : item.amountCents} /></div><div className="mt-4 flex flex-wrap justify-end gap-2"><SmallButton onClick={() => onEdit(item)}>Edit</SmallButton>{hasHistory ? item.isActive && <SmallButton onClick={() => onDeactivate(item.id)}>Deactivate</SmallButton> : <SmallButton onClick={() => onDelete(item.id)}>Delete</SmallButton>}{item.isActive && <SmallButton primary onClick={() => onComplete(item)}>Mark {item.kind === "expense" ? "paid" : "received"}</SmallButton>}</div></div>; })}</div>{data.plannedCompletions.length > 0 && <section className="mt-8"><SectionTitle title="Completion history" subtitle="Original records are retained for audit" /><div className="mt-3 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white px-4 sm:px-5">{data.plannedCompletions.map((completion) => { const transaction = completion.effectiveTransaction; const original = completion.originalTransaction; return <div key={completion.id} className="flex flex-wrap items-center gap-3 py-4"><div className="min-w-0 flex-1"><p className="truncate font-medium">{transaction?.description ?? original.description}</p><p className="truncate text-xs text-stone-400">{completion.status} · due {prettyDate(completion.occurrenceDate)}{transaction ? ` · effective ${prettyDate(transaction.date)} · ${accounts[transaction.accountId] ?? "Unknown account"}` : ""}</p>{completion.status !== "completed" && <p className="mt-1 truncate text-xs text-stone-400">Original: {prettyDate(original.date)} · {accounts[original.accountId] ?? "Unknown account"} · {money(original.amountCents)}</p>}</div>{transaction && <Amount cents={transaction.amountCents} />}{completion.adjustable && <div className="flex gap-1"><SmallButton onClick={() => onCorrect(completion)}>Correct</SmallButton><SmallButton onClick={() => onUndo(completion)}>Undo</SmallButton></div>}</div>; })}</div></section>}</Page>;
}

function Reserves({ data, onAdd, onEdit, onDelete }: { data: AppData; onAdd: () => void; onEdit: (item: Reserve) => void; onDelete: (id: string) => void }) {
  const planned = useMemo(() => Object.fromEntries(data.plannedTransactions.map((item) => [item.id, item])), [data.plannedTransactions]);
  return <Page title="Protected reserves" subtitle="Protect money now, or set a target and deadline to calculate this month's contribution." action="Add reserve" onAction={onAdd}><div className="grid gap-3 sm:grid-cols-2">{data.reserves.length === 0 ? <Card><EmptyLine>No reserves yet.</EmptyLine></Card> : data.reserves.map((item) => { const progress = item.targetAmountCents == null ? 0 : Math.min(100, item.fundedAmountCents / item.targetAmountCents * 100); const linked = item.linkedPlannedTransactionId ? planned[item.linkedPlannedTransactionId] : undefined; return <Card key={item.id} inactive={!item.isActive}><div className="flex items-start justify-between gap-4"><div><h3 className="font-semibold">{item.name}</h3><p className="mt-1 text-sm text-stone-500">{item.note || "Protected funds"}</p>{linked && <p className="mt-1 text-xs text-stone-400">Linked to {linked.description} · due {prettyDate(linked.nextDate)}{!linked.isActive ? " · inactive" : ""}</p>}</div><p className="text-xl font-semibold">{money(item.fundedAmountCents)}</p></div>{item.targetAmountCents != null && item.targetDate && <div className="mt-4"><div className="flex justify-between text-xs text-stone-500"><span>{Math.floor(progress)}% funded</span><span>Goal {money(item.targetAmountCents)} by {prettyDate(item.targetDate)}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-100"><div className="h-full rounded-full bg-green-700" style={{ width: `${progress}%` }} /></div><p className="mt-3 text-sm font-medium text-green-800">{!item.isActive ? "Inactive goal" : item.requiredContributionCents > 0 ? `Still protect ${money(item.requiredContributionCents)} this month` : item.fundedAmountCents >= item.targetAmountCents ? "Goal funded" : "This month's contribution is funded"}</p></div>}<div className="mt-5 flex justify-end gap-2"><SmallButton onClick={() => onEdit(item)}>Edit</SmallButton><SmallButton onClick={() => onDelete(item.id)}>Delete</SmallButton></div></Card>; })}</div></Page>;
}

function Accounts({ data, onAdd, onEdit, onReconcile, onDelete }: { data: AppData; onAdd: () => void; onEdit: (item: Account) => void; onReconcile: (item: Account) => void; onDelete: (id: string) => void }) {
  const accounts = useMemo(() => Object.fromEntries(data.accounts.map((account) => [account.id, account.name])), [data.accounts]);
  return <Page title="Accounts" subtitle="Balances are current cleared amounts. Use reconciliation to align one with the bank." action="Add account" onAction={onAdd}><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{data.accounts.map((item) => <Card key={item.id} inactive={!item.isActive}><p className="text-xs font-medium uppercase tracking-wider text-stone-400">{item.type}</p><h3 className="mt-2 font-semibold">{item.name}</h3><p className="mt-5 text-2xl font-semibold">{money(item.balanceCents)}</p><div className="mt-5 flex justify-end gap-2"><SmallButton onClick={() => onEdit(item)}>Edit</SmallButton>{item.isActive && <SmallButton primary onClick={() => onReconcile(item)}>Reconcile</SmallButton>}<SmallButton onClick={() => onDelete(item.id)}>Delete</SmallButton></div></Card>)}</div>{data.accountReconciliations.length > 0 && <section className="mt-8"><SectionTitle title="Reconciliation history" subtitle="Balance checkpoints retained for audit" /><div className="mt-3 divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white px-4 sm:px-5">{data.accountReconciliations.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 py-4"><div className="min-w-0 flex-1"><p className="font-medium">{accounts[item.accountId] ?? "Unknown account"}</p><p className="text-xs text-stone-400">{prettyDate(item.date)} · {money(item.previousBalanceCents)} → {money(item.actualBalanceCents)}{item.note ? ` · ${item.note}` : ""}</p></div><Amount cents={item.differenceCents} /></div>)}</div></section>}</Page>;
}

function EditorModal({ editor, data, busy, onClose, onSave }: { editor: NonNullable<Editor>; data: AppData; busy: boolean; onClose: () => void; onSave: (payload: unknown) => Promise<void> }) {
  const item = editor.item;
  const baseDate = today();
  const initial = editor.type === "correction" ? { amount: euros(Math.abs(editor.item.effectiveTransaction?.amountCents ?? 0)), date: editor.item.effectiveTransaction?.date ?? baseDate, accountId: editor.item.effectiveTransaction?.accountId ?? data.accounts[0]?.id ?? "" } : editor.type === "reconciliation" ? { actualBalance: euros(editor.item.balanceCents), date: baseDate, note: "" } : editor.type === "transfer" && editor.item ? { description: editor.item.description, amount: euros(Math.abs(editor.item.amountCents)), date: editor.item.date, fromAccountId: editor.item.amountCents < 0 ? editor.item.accountId : "", toAccountId: transferDestination(data.transactions, editor.item.transferGroupId) } : editor.item ? itemToForm(editor.type, editor.item) : editor.type === "account" ? { name: "", type: "checking", balance: "0.00", isActive: true } : editor.type === "transaction" ? { description: "", kind: "expense", amount: "", date: baseDate, accountId: data.accounts[0]?.id ?? "" } : editor.type === "transfer" ? { description: "Transfer", amount: "", date: baseDate, fromAccountId: data.accounts[0]?.id ?? "", toAccountId: data.accounts[1]?.id ?? "" } : editor.type === "planned" ? { description: "", kind: "expense", amount: "", nextDate: baseDate, recurrence: "monthly", intervalCount: "1", endDate: "", accountId: data.accounts[0]?.id ?? "", isActive: true } : { name: "", funded: "", note: "", hasGoal: false, target: "", targetDate: "", linkedPlannedTransactionId: "", isActive: true };
  const [form, setForm] = useState<Record<string, string | boolean>>(initial);
  const [formError, setFormError] = useState("");
  const reserveId = editor.type === "reserve" ? editor.item?.id : undefined;
  const linkedElsewhere = new Set(data.reserves.filter((reserve) => reserve.id !== reserveId && reserve.linkedPlannedTransactionId).map((reserve) => reserve.linkedPlannedTransactionId));
  const eligiblePlannedExpenses = data.plannedTransactions.filter((planned) =>
    planned.kind === "expense" && planned.recurrence === "once" &&
    ((planned.isActive && !linkedElsewhere.has(planned.id)) || planned.id === form.linkedPlannedTransactionId)
  );
  const set = (key: string) => (event: FormEvent<Element>) => {
    const target = event.currentTarget as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    setForm((current) => ({ ...current, [key]: target instanceof HTMLInputElement && target.type === "checkbox" ? target.checked : target.value }));
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    try {
      const amountCents = editor.type === "account"
        ? parseMoney(String(form.balance), true)
        : editor.type === "reconciliation"
        ? parseMoney(String(form.actualBalance), true)
        : editor.type === "reserve"
        ? parseMoney(String(form.funded))
        : parseMoney(String(form.amount));
      const payload = editor.type === "correction" ? { amountCents, date: form.date, accountId: form.accountId }
        : editor.type === "reconciliation" ? { actualBalanceCents: amountCents, date: form.date, note: form.note }
        : editor.type === "account" ? { name: form.name, type: form.type, balanceCents: amountCents, isActive: form.isActive ?? true }
        : editor.type === "transaction" ? { description: form.description, kind: form.kind, amountCents, date: form.date, accountId: form.accountId }
        : editor.type === "transfer" ? { description: form.description, amountCents, date: form.date, fromAccountId: form.fromAccountId, toAccountId: form.toAccountId }
        : editor.type === "planned" ? { description: form.description, kind: form.kind, amountCents, nextDate: form.nextDate, recurrence: form.recurrence, intervalCount: Number(form.intervalCount), endDate: form.endDate || null, accountId: form.accountId || null, isActive: form.isActive ?? true }
        : { name: form.name, fundedAmountCents: amountCents, targetAmountCents: form.hasGoal ? parseMoney(String(form.target)) : null, targetDate: form.hasGoal ? form.targetDate : null, linkedPlannedTransactionId: form.hasGoal ? form.linkedPlannedTransactionId || null : null, note: form.note, isActive: form.isActive ?? true };
      await onSave(payload);
    } catch (err) {
      setFormError(messageOf(err));
    }
  };
  const title = editor.type === "correction" ? "Correct completion" : editor.type === "reconciliation" ? `Reconcile ${editor.item.name}` : `${item ? "Edit" : "Add"} ${editor.type === "planned" ? "planned item" : editor.type}`;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-950 bg-opacity-50 p-0 sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="editor-title" className="max-h-screen w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-lg sm:rounded-3xl sm:p-7">
        <div className="flex items-center justify-between"><h2 id="editor-title" className="text-xl font-semibold capitalize">{title}</h2><button className="rounded-full p-2 text-xl text-stone-400 hover:bg-stone-100" onClick={onClose} aria-label="Close">×</button></div>
        <form className="mt-6 grid gap-4" onSubmit={submit}>
          {editor.type === "account" && <><Field label="Account name"><input required maxLength={80} value={String(form.name)} onInput={set("name")} className={inputClass} /></Field><Field label="Account type"><select value={String(form.type)} onChange={set("type")} className={inputClass}><option value="checking">Checking</option><option value="savings">Savings</option><option value="cash">Cash</option></select></Field>{!item && <MoneyField label="Current balance" value={String(form.balance)} onInput={set("balance")} allowNegative />}</>}
          {editor.type === "transaction" && <><Field label="Description"><input required maxLength={160} value={String(form.description)} onInput={set("description")} className={inputClass} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Type"><select value={String(form.kind)} onChange={set("kind")} className={inputClass}><option value="expense">Expense</option><option value="income">Income</option></select></Field><MoneyField label="Amount" value={String(form.amount)} onInput={set("amount")} /></div><Field label="Date"><input type="date" required value={String(form.date)} onInput={set("date")} className={inputClass} /></Field><AccountSelect accounts={data.accounts} value={String(form.accountId)} onChange={set("accountId")} /></>}
          {editor.type === "transfer" && <><p className="text-sm text-stone-500">Transfers are recorded as matching debit and credit legs, and never count as household income or spending.</p><Field label="Description"><input required maxLength={160} value={String(form.description)} onInput={set("description")} className={inputClass} /></Field><MoneyField label="Amount" value={String(form.amount)} onInput={set("amount")} /><Field label="Date"><input type="date" required value={String(form.date)} onInput={set("date")} className={inputClass} /></Field><AccountSelect label="From account" accounts={data.accounts} value={String(form.fromAccountId)} onChange={set("fromAccountId")} /><AccountSelect label="To account" accounts={data.accounts} value={String(form.toAccountId)} onChange={set("toAccountId")} /></>}
          {editor.type === "planned" && <><Field label="Description"><input required maxLength={160} value={String(form.description)} onInput={set("description")} className={inputClass} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Type"><select value={String(form.kind)} onChange={set("kind")} className={inputClass}><option value="expense">Expense</option><option value="income">Income</option></select></Field><MoneyField label="Amount" value={String(form.amount)} onInput={set("amount")} /></div><Field label="Next due date"><input type="date" required value={String(form.nextDate)} onInput={set("nextDate")} className={inputClass} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Repeats"><select value={String(form.recurrence)} onChange={set("recurrence")} className={inputClass}><option value="once">Once</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></Field><Field label="Every"><input type="number" min="1" max="99" required value={String(form.intervalCount)} onInput={set("intervalCount")} className={inputClass} /></Field></div><Field label="End date (optional)"><input type="date" value={String(form.endDate)} onInput={set("endDate")} className={inputClass} /></Field><AccountSelect accounts={data.accounts} value={String(form.accountId)} onChange={set("accountId")} optional /></>}
          {editor.type === "correction" && <><MoneyField label="Correct amount" value={String(form.amount)} onInput={set("amount")} /><Field label="Correct date"><input type="date" required value={String(form.date)} onInput={set("date")} className={inputClass} /></Field><AccountSelect accounts={data.accounts} value={String(form.accountId)} onChange={set("accountId")} /></>}
          {editor.type === "reconciliation" && <><p className="text-sm text-stone-500">Current BudgetApp balance: <strong>{money(editor.item.balanceCents)}</strong></p><MoneyField label="Actual cleared balance" value={String(form.actualBalance)} onInput={set("actualBalance")} allowNegative /><Field label="Reconciliation date"><input type="date" required value={String(form.date)} onInput={set("date")} className={inputClass} /></Field><Field label="Note (optional)"><textarea maxLength={300} rows={3} value={String(form.note)} onInput={set("note")} className={inputClass} /></Field></>}
          {editor.type === "reserve" && <><Field label="Reserve name"><input required maxLength={80} value={String(form.name)} onInput={set("name")} className={inputClass} /></Field><MoneyField label="Already funded" value={String(form.funded)} onInput={set("funded")} /><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={Boolean(form.hasGoal)} onChange={set("hasGoal")} className="h-4 w-4 accent-green-800" /> Set a target and deadline</label>{form.hasGoal && <><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><MoneyField label="Target amount" value={String(form.target)} onInput={set("target")} /><Field label="Target date"><input type="date" required value={String(form.targetDate)} onInput={set("targetDate")} className={inputClass} /></Field></div><Field label="Planned expense (optional)"><select value={String(form.linkedPlannedTransactionId)} onChange={set("linkedPlannedTransactionId")} className={inputClass}><option value="">Do not link</option>{eligiblePlannedExpenses.map((planned) => <option key={planned.id} value={planned.id}>{planned.description} · {prettyDate(planned.nextDate)}{!planned.isActive ? " · inactive" : ""}</option>)}</select></Field><p className="-mt-2 text-xs text-stone-400">Link one active, one-off expense so its goal funding is not deducted twice.</p></>}<Field label="Note (optional)"><textarea maxLength={300} rows={3} value={String(form.note)} onInput={set("note")} className={inputClass} /></Field></>}
          {item && (editor.type === "account" || editor.type === "planned" || editor.type === "reserve") && <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={Boolean(form.isActive)} onChange={set("isActive")} className="h-4 w-4 accent-green-800" /> Active</label>}
          {formError && <p className="text-sm text-red-700">{formError}</p>}
          <div className="mt-2 flex justify-end gap-2"><Button secondary type="button" onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button></div>
        </form>
      </div>
    </div>
  );
}

function EmptyStart({ busy, canCleanupDemo, onDemo, onAccount, onCleanupDemo }: { busy: boolean; canCleanupDemo: boolean; onDemo: () => void; onAccount: () => void; onCleanupDemo: () => void }) {
  return <div className="mx-auto max-w-xl rounded-3xl border border-stone-200 bg-white p-7 text-center sm:p-12"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-lime-200 text-2xl text-green-950">€</div><h1 className="mt-6 text-2xl font-semibold">Start with your current cash</h1><p className="mx-auto mt-3 max-w-md text-stone-500">{canCleanupDemo ? "Synthetic demo records remain without an account. Remove them before starting with real data." : "Add a real account balance, or load clearly synthetic data to explore the workflow first."}</p><div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row"><Button onClick={onAccount}>Add account</Button>{canCleanupDemo ? <Button secondary onClick={onCleanupDemo} disabled={busy}>Remove demo data</Button> : <Button secondary onClick={onDemo} disabled={busy}>{busy ? "Loading…" : "Load synthetic demo"}</Button>}</div></div>;
}

function Page({ title, subtitle, action, onAction, children }: { title: string; subtitle: string; action: string; onAction: () => void; children: ReactNode }) {
  return <div><div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h1 className="text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 text-sm text-stone-500">{subtitle}</p></div><Button onClick={onAction}>{action}</Button></div>{children}</div>;
}

function ListRow({ title, meta, amount, inactive, onEdit, onDelete }: { title: string; meta: string; amount: number; inactive?: boolean; onEdit?: () => void; onDelete?: () => void }) {
  return <div className={`flex items-center gap-3 py-4 ${inactive ? "opacity-60" : ""}`}><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg ${amount < 0 ? "bg-orange-50 text-orange-700" : "bg-green-50 text-green-700"}`}>{amount < 0 ? "−" : "+"}</div><div className="min-w-0 flex-1"><p className="truncate font-medium">{title}</p><p className="truncate text-xs text-stone-400">{meta}</p></div><Amount cents={amount} /><div className="flex"><button disabled={!onEdit} onClick={onEdit} className="px-2 py-1 text-xs text-stone-400 disabled:invisible">Edit</button><button disabled={!onDelete} onClick={onDelete} className="px-2 py-1 text-xs text-stone-400 hover:text-red-700 disabled:invisible">Delete</button></div></div>;
}

function Metric({ label, value, positive, negative }: { label: string; value: number; positive?: boolean; negative?: boolean }) {
  return <div className="rounded-2xl border border-stone-200 bg-white p-4 sm:p-5"><p className="text-xs font-medium text-stone-500 sm:text-sm">{label}</p><p className={`mt-2 text-xl font-semibold sm:text-2xl ${positive ? "text-green-700" : negative ? "text-orange-700" : ""}`}>{money(value)}</p></div>;
}
function Card({ children, inactive }: { children: ReactNode; inactive?: boolean }) { return <div className={`rounded-2xl border border-stone-200 bg-white p-5 ${inactive ? "opacity-60" : ""}`}>{children}</div>; }
function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) { return <div className="flex items-baseline justify-between gap-3"><h2 className="font-semibold">{title}</h2>{subtitle && <span className="text-xs text-stone-400">{subtitle}</span>}</div>; }
function SummaryRow({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) { return <div className="flex items-center justify-between gap-3"><span className={strong ? "font-medium" : "text-sm text-stone-500"}>{label}</span><span className={strong ? "font-semibold" : "text-sm"}>{money(cents)}</span></div>; }
function Amount({ cents }: { cents: number }) { return <span className={`whitespace-nowrap font-semibold tabular-nums ${cents < 0 ? "text-stone-800" : "text-green-700"}`}>{cents > 0 ? "+" : ""}{money(cents)}</span>; }
function DateBadge({ date }: { date: string }) { const parsed = new Date(`${date}T12:00:00Z`); return <div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl bg-stone-100 leading-none"><span className="text-[10px] font-semibold uppercase text-stone-400">{parsed.toLocaleDateString("en", { month: "short", timeZone: "UTC" })}</span><span className="mt-1 text-sm font-semibold">{parsed.getUTCDate()}</span></div>; }
function Badge({ children }: { children: ReactNode }) { return <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-stone-500">{children}</span>; }
function EmptyLine({ children }: { children: ReactNode }) { return <p className="py-8 text-center text-sm text-stone-400">{children}</p>; }
function Centered({ children }: { children: ReactNode }) { return <main className="flex min-h-screen items-center justify-center bg-stone-100 p-5">{children}</main>; }
function Spinner({ label }: { label: string }) { return <div className="text-center"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-green-800" /><p className="mt-4 text-sm text-stone-500">{label}</p></div>; }
function Brand() { return <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-950 font-semibold text-lime-200">€</span><span className="font-semibold tracking-tight">BudgetApp</span></div>; }
function Logout({ compact }: { compact?: boolean }) { return <form method="POST" action="/auth/logout" className={compact ? "mt-0" : "mt-6"}><button className="rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-500 hover:bg-white">Log out</button></form>; }
function Button({ children, secondary, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) { return <button {...props} className={`rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${secondary ? "border border-stone-200 bg-white text-stone-700 hover:bg-stone-50" : "bg-green-900 text-white hover:bg-green-800"}`}>{children}</button>; }
function SmallButton({ children, primary, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) { return <button {...props} className={`rounded-lg px-3 py-2 text-xs font-medium ${primary ? "bg-green-900 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"}`}>{children}</button>; }
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="grid gap-1.5 text-sm font-medium text-stone-700"><span>{label}</span>{children}</label>; }
function MoneyField({ label, value, onInput, allowNegative }: { label: string; value: string; onInput: (event: FormEvent<Element>) => void; allowNegative?: boolean }) { return <Field label={label}><div className="relative"><span className="absolute left-3 top-2.5 text-stone-400">€</span><input inputMode="decimal" required pattern={allowNegative ? "-?[0-9]+([.,][0-9]{1,2})?" : "[0-9]+([.,][0-9]{1,2})?"} placeholder="0.00" value={value} onInput={onInput} className={`${inputClass} pl-8`} /></div></Field>; }
function AccountSelect({ accounts, value, onChange, optional, label }: { accounts: Account[]; value: string; onChange: (event: FormEvent<Element>) => void; optional?: boolean; label?: string }) { return <Field label={label ?? `Account${optional ? " (optional)" : ""}`}><select required={!optional} value={value} onChange={onChange} className={inputClass}>{optional && <option value="">Choose when paid</option>}{accounts.filter((a) => a.isActive || a.id === value).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></Field>; }

const inputClass = "w-full box-border rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-base outline-none focus:border-green-700 focus:ring-2 focus:ring-green-100";

function itemToForm(type: Exclude<NonNullable<Editor>["type"], "correction" | "reconciliation">, item: Account | Transaction | PlannedTransaction | Reserve): Record<string, string | boolean> {
  if (type === "account") { const a = item as Account; return { name: a.name, type: a.type, balance: euros(a.balanceCents), isActive: a.isActive }; }
  if (type === "transaction") { const t = item as Transaction; return { description: t.description, kind: t.kind, amount: euros(Math.abs(t.amountCents)), date: t.date, accountId: t.accountId }; }
  if (type === "planned") { const p = item as PlannedTransaction; return { description: p.description, kind: p.kind, amount: euros(p.amountCents), nextDate: p.nextDate, recurrence: p.recurrence, intervalCount: String(p.intervalCount), endDate: p.endDate ?? "", accountId: p.accountId ?? "", isActive: p.isActive }; }
  const r = item as Reserve; return { name: r.name, funded: euros(r.fundedAmountCents), note: r.note, hasGoal: r.targetAmountCents != null, target: r.targetAmountCents == null ? "" : euros(r.targetAmountCents), targetDate: r.targetDate ?? "", linkedPlannedTransactionId: r.linkedPlannedTransactionId ?? "", isActive: r.isActive };
}

function transferDestination(transactions: Transaction[], groupId: string | null): string {
  return groupId ? transactions.find((transaction) => transaction.transferGroupId === groupId && transaction.amountCents > 0)?.accountId ?? "" : "";
}

async function api<T = unknown>(path: string, init?: RequestInit, requireOk = true): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "X-BudgetApp-Request": "1", ...(init?.headers ?? {}) } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (requireOk && !response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`);
  return body as T;
}

function parseMoney(raw: string, allowNegative = false): number {
  const normalized = raw.trim().replace(",", ".");
  if (!(allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(normalized)) throw new Error("Enter a valid amount with at most two decimals");
  const negative = normalized.startsWith("-");
  const [whole, decimal = ""] = normalized.replace("-", "").split(".");
  const cents = Number(BigInt(whole) * 100n + BigInt(decimal.padEnd(2, "0")));
  if (!Number.isSafeInteger(cents)) throw new Error("Amount is too large");
  return negative ? -cents : cents;
}
function money(cents: number): string { return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100); }
function euros(cents: number): string { return `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`; }
function today(): string { return householdDate(); }
function prettyDate(date: string): string { return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); }
function prettyMonth(date: string): string { return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
function confirmed(message: string): boolean { return window.confirm(message); }
