//! O que o relay devolve ao Claude Code num `PermissionRequest`.
//! Adaptado do `coucou-hook` (MIT, © Louis Raillé).
//!
//! Regra: **nada que permita algo é impresso sem um clique humano.** Sem decisão,
//! silêncio — e o Claude Code pergunta no próprio chat, como se o pet não existisse.

use serde_json::{json, Map, Value};

/// O que imprimir para `agent` dada a decisão do balão. O Claude Code lê o JSON
/// documentado; o plugin do OpenCode lê só a palavra (`allow`/`deny`) e responde
/// pela API do próprio OpenCode.
pub fn stdout_for(agent: &str, decision: &str, question: Option<&Value>) -> Option<String> {
    match agent {
        "" | "claude" => decision_json(decision, question),
        "opencode" => matches!(decision.trim(), "allow" | "deny").then(|| decision.trim().to_string()),
        _ => None,
    }
}

/// A saída documentada do PermissionRequest (https://code.claude.com/docs/en/hooks).
/// `question` é o input do AskUserQuestion quando é isso que foi perguntado: o
/// balão responde devolvendo o mesmo input com o mapa `answers`.
pub fn decision_json(decision: &str, question: Option<&Value>) -> Option<String> {
    if decision.trim_start().starts_with('{') {
        let reply = serde_json::from_str::<Value>(decision).ok()?;
        let answers = reply.get("answers")?.as_object()?;
        let question = question?;
        if !answers_fit(question, answers) {
            return None;
        }
        let mut input = question.as_object()?.clone();
        input.insert("answers".into(), Value::Object(answers.clone()));
        return Some(
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "allow", "updatedInput": input },
                }
            })
            .to_string(),
        );
    }
    let behavior = match decision.trim() {
        "allow" => json!({ "behavior": "allow" }),
        "deny" => json!({ "behavior": "deny", "message": "Negado pelo Digitama" }),
        _ => return None,
    };
    Some(json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": behavior } }).to_string())
}

/// As respostas cobrem exatamente as perguntas feitas: uma por pergunta, pelo
/// texto; escolha única = um rótulo; múltipla = lista não vazia de rótulos distintos.
fn answers_fit(question: &Value, answers: &Map<String, Value>) -> bool {
    let Some(items) = question.get("questions").and_then(|q| q.as_array()) else { return false };
    if items.is_empty() || items.len() != answers.len() {
        return false;
    }
    items.iter().all(|item| {
        let Some(text) = item.get("question").and_then(|q| q.as_str()) else { return false };
        let labels: Vec<&str> = item
            .get("options")
            .and_then(|o| o.as_array())
            .map(|opts| opts.iter().filter_map(|o| o.get("label").and_then(|l| l.as_str())).collect())
            .unwrap_or_default();
        let multi = item.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false);
        match answers.get(text) {
            Some(Value::String(pick)) if !multi => labels.contains(&pick.as_str()),
            Some(Value::Array(picks)) if multi => {
                let picks: Vec<&str> = picks.iter().filter_map(|p| p.as_str()).collect();
                let mut seen = picks.clone();
                seen.sort_unstable();
                seen.dedup();
                !picks.is_empty() && seen.len() == picks.len() && picks.iter().all(|p| labels.contains(p))
            }
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_agente_recebe_o_seu_formato() {
        assert!(stdout_for("", "allow", None).unwrap().contains("hookSpecificOutput"));
        assert_eq!(stdout_for("opencode", "deny", None).as_deref(), Some("deny"));
        assert!(stdout_for("opencode", r#"{"answers":{}}"#, None).is_none());
        assert!(stdout_for("codex", "allow", None).is_none());
    }

    #[test]
    fn so_allow_e_deny_viram_decisao() {
        assert!(decision_json("allow", None).unwrap().contains(r#""behavior":"allow""#));
        assert!(decision_json("deny", None).unwrap().contains(r#""behavior":"deny""#));
        for nada in ["", "ask", "talvez", r#"{"permissionDecision":"allow"}"#] {
            assert!(decision_json(nada, None).is_none(), "{nada}");
        }
    }

    #[test]
    fn resposta_volta_como_o_mesmo_input_mais_answers() {
        let q = json!({ "questions": [{ "question": "Qual?", "options": [{ "label": "A" }, { "label": "B" }] }] });
        let out = decision_json(r#"{"answers":{"Qual?":"B"}}"#, Some(&q)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["Qual?"], "B");
        assert!(decision_json(r#"{"answers":{"Qual?":"C"}}"#, Some(&q)).is_none());
        assert!(decision_json(r#"{"answers":{"Qual?":"A"}}"#, None).is_none());
    }

    #[test]
    fn multipla_escolha_exige_lista_valida() {
        let q = json!({ "questions": [{ "question": "Extras?", "multiSelect": true,
            "options": [{ "label": "Testes" }, { "label": "Docs" }] }] });
        assert!(decision_json(r#"{"answers":{"Extras?":["Testes","Docs"]}}"#, Some(&q)).is_some());
        assert!(decision_json(r#"{"answers":{"Extras?":[]}}"#, Some(&q)).is_none());
        assert!(decision_json(r#"{"answers":{"Extras?":["Testes","Testes"]}}"#, Some(&q)).is_none());
        assert!(decision_json(r#"{"answers":{"Extras?":"Testes"}}"#, Some(&q)).is_none());
    }
}
