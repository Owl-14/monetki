import { profileOf, tochkaSyncAccess } from "./rules.js";
import { ensureCoreData, findUser } from "./auth/access.ts";
import {
  addComment,
  backup,
  bootstrap,
  closeEventSettlement,
  createItem,
  createEventFinanceAllocation,
  deleteItem,
  getFile,
  importPlayers,
  markRead,
  migrateImport,
  processBankTransaction,
  resolveExpense,
  statusInfo,
  updateItem,
  uploadFile,
} from "./actions.ts";
import { runTochkaSync } from "./bank.ts";
import { readAll } from "./db/repositories.ts";
import {
  applyBankRuleSuggestion,
  bankRuleJournal,
  correctBankRuleApplication,
  dryRunBankRules,
  deleteBankRule,
  enableBankRule,
  getBankRuleSettings,
  ignoreBankTransaction,
  listBankRules,
  previewBankRuleTransaction,
  reevaluateBankTransaction,
  rejectBankRuleSuggestion,
  requireManualBankTransaction,
  reverseBankRuleApplication,
  saveBankRule,
  updateBankRuleSettings,
} from "./bank-rule-actions.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-tochka-sync-secret",
  "Content-Type": "application/json",
};

export async function handleRequest(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, app: "monetki", backend: "supabase" }), { headers: CORS });
  }
  try {
    const body = await req.json();
    const action = body.action;

    if (action === "login") {
      const u = await findUser(body.code);
      if (!u) return json({ ok: false, error: "Неверный код доступа" });
      await ensureCoreData();
      const memberships = await readAll("memberships");
      return json({ ok: true, token: u.code, profile: profileOf(u, memberships) });
    }
    if (action === "status") return json(await statusInfo(await findUser(body.token)));
    if (action === "tochka_sync") {
      const user = await findUser(body.token);
      const access = tochkaSyncAccess(
        user,
        req.headers.get("x-tochka-sync-secret"),
        Deno.env.get("TOCHKA_SYNC_SECRET"),
      );
      if (!access) return json({ ok: false, error: "auth" }, 401);
      return json(await runTochkaSync(body.days || 30));
    }
    if (action === "migrate_import") {
      return json(await migrateImport(await findUser(body.token), body.data));
    }

    const user = await findUser(body.token);
    if (!user) return json({ ok: false, error: "auth" });

    switch (action) {
      case "bootstrap":
        await ensureCoreData();
        return json(await bootstrap(user));
      case "backup":
        await ensureCoreData();
        return json(await backup(user));
      case "create": return json(await createItem(user, body.entity, body.item));
      case "update": return json(await updateItem(user, body.entity, body.item));
      case "delete": return json(await deleteItem(user, body.entity, body.id));
      case "comment": return json(await addComment(user, body.taskId, body.text));
      case "import_players": return json(await importPlayers(user, body.rows));
      case "mark_read": return json(await markRead(user, body.ids));
      case "resolve_expense": return json(await resolveExpense(user, body.id, body.how));
      case "process_bank_transaction": return json(await processBankTransaction(user, body.id, body.businessId, body.category));
      case "bank_rules_list": return json(await listBankRules(user));
      case "bank_rule_save": return json(await saveBankRule(user, body.rule, body.expectedVersion));
      case "bank_rule_enable": return json(await enableBankRule(user, body.id, body.enabled, body.expectedVersion));
      case "bank_rule_delete": return json(await deleteBankRule(user, body.id, body.expectedVersion));
      case "bank_rule_settings_get": return json(await getBankRuleSettings(user));
      case "bank_rule_settings_update": return json(await updateBankRuleSettings(user, body.settings, body.expectedVersion));
      case "bank_rule_preview_transaction": return json(await previewBankRuleTransaction(user, body.transactionId, body.draft));
      case "bank_rule_dry_run": return json(await dryRunBankRules(user, body.draft));
      case "bank_rule_apply_suggestion": return json(await applyBankRuleSuggestion(user, body.transactionId, body.expectedEvaluationToken, body.idempotencyKey));
      case "bank_rule_reject_suggestion": return json(await rejectBankRuleSuggestion(user, body.transactionId, body.idempotencyKey));
      case "bank_rule_ignore": return json(await ignoreBankTransaction(user, body.transactionId, body.idempotencyKey));
      case "bank_rule_manual": return json(await requireManualBankTransaction(user, body.transactionId, body.idempotencyKey));
      case "bank_rule_reevaluate": return json(await reevaluateBankTransaction(user, body.transactionId, body.idempotencyKey));
      case "bank_rule_journal": return json(await bankRuleJournal(user, body.limit));
      case "bank_rule_correct": return json(await correctBankRuleApplication(user, body.applicationId, body.patch, body.idempotencyKey));
      case "bank_rule_reverse": return json(await reverseBankRuleApplication(user, body.applicationId, body.idempotencyKey));
      case "allocate_event_finance": return json(await createEventFinanceAllocation(user, body.item));
      case "close_event_settlement": return json(await closeEventSettlement(user, body.id));
      case "upload_file": return json(await uploadFile(user, body.b64));
      case "get_file": return json(await getFile(user, body.id));
      default: return json({ ok: false, error: "Неизвестное действие" });
    }
  } catch (_error) {
    // Внутренняя ошибка может содержать фрагмент банковского ответа или SQL-контекст.
    return json({ ok: false, error: "Ошибка сервера" });
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}
