//! Tool-argument validation and coercion.
//!
//! Port of pi-mono `packages/ai/src/utils/validation.ts`. pi leans on TypeBox
//! for the actual check; here a small JSON-schema subset validator covers what
//! tool schemas in practice use (`type`, `properties`, `required`, `items`,
//! `enum`, `const`, `anyOf`/`oneOf`/`allOf`, numeric/length bounds,
//! `additionalProperties`). Coercion (string→number, "true"→bool, dropped
//! optional nulls) runs first so models that stringify numbers still work.

use serde_json::{Map, Value};

use super::types::{Tool, ToolCall};

fn schema_types(schema: &Value) -> Vec<&str> {
    match schema.get("type") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str()).collect(),
        _ => vec![],
    }
}

fn matches_json_type(value: &Value, ty: &str) -> bool {
    match ty {
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some() || value.as_f64().map_or(false, |f| f.fract() == 0.0),
        "boolean" => value.is_boolean(),
        "string" => value.is_string(),
        "null" => value.is_null(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => false,
    }
}

fn coerce_primitive_by_type(value: &Value, ty: &str) -> Value {
    match ty {
        "number" => match value {
            Value::Null => Value::from(0),
            Value::String(s) if !s.trim().is_empty() => match s.trim().parse::<f64>() {
                Ok(f) if f.is_finite() => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or_else(|| value.clone()),
                _ => value.clone(),
            },
            Value::Bool(b) => Value::from(if *b { 1 } else { 0 }),
            _ => value.clone(),
        },
        "integer" => match value {
            Value::Null => Value::from(0),
            Value::String(s) if !s.trim().is_empty() => match s.trim().parse::<i64>() {
                Ok(i) => Value::from(i),
                Err(_) => value.clone(),
            },
            Value::Bool(b) => Value::from(if *b { 1 } else { 0 }),
            Value::Number(n) => match n.as_f64() {
                Some(f) if f.fract() == 0.0 && n.as_i64().is_none() => Value::from(f as i64),
                _ => value.clone(),
            },
            _ => value.clone(),
        },
        "boolean" => match value {
            Value::Null => Value::Bool(false),
            Value::String(s) if s == "true" => Value::Bool(true),
            Value::String(s) if s == "false" => Value::Bool(false),
            Value::Number(n) if n.as_f64() == Some(1.0) => Value::Bool(true),
            Value::Number(n) if n.as_f64() == Some(0.0) => Value::Bool(false),
            _ => value.clone(),
        },
        "string" => match value {
            Value::Null => Value::String(String::new()),
            Value::Number(n) => Value::String(n.to_string()),
            Value::Bool(b) => Value::String(b.to_string()),
            _ => value.clone(),
        },
        "null" => match value {
            Value::String(s) if s.is_empty() => Value::Null,
            Value::Number(n) if n.as_f64() == Some(0.0) => Value::Null,
            Value::Bool(false) => Value::Null,
            _ => value.clone(),
        },
        _ => value.clone(),
    }
}

fn coerce_with_union(value: Value, schemas: &[Value]) -> Value {
    for s in schemas {
        if validate(&value, s, "").is_empty() {
            return value;
        }
    }
    for s in schemas {
        let coerced = coerce_with_schema(value.clone(), s);
        if validate(&coerced, s, "").is_empty() {
            return coerced;
        }
    }
    value
}

fn coerce_with_schema(value: Value, schema: &Value) -> Value {
    let mut next = value;
    if let Some(all) = schema.get("allOf").and_then(|v| v.as_array()) {
        for nested in all {
            next = coerce_with_schema(next, nested);
        }
    }
    if let Some(any) = schema.get("anyOf").and_then(|v| v.as_array()) {
        next = coerce_with_union(next, any);
    }
    if let Some(one) = schema.get("oneOf").and_then(|v| v.as_array()) {
        next = coerce_with_union(next, one);
    }

    let types = schema_types(schema);
    let matches_union_member = types.len() > 1 && types.iter().any(|t| matches_json_type(&next, t));
    if !types.is_empty() && !matches_union_member {
        for t in &types {
            let candidate = coerce_primitive_by_type(&next, t);
            if candidate != next {
                next = candidate;
                break;
            }
        }
    }

    if types.contains(&"object") {
        if let Value::Object(map) = &mut next {
            let props = schema.get("properties").and_then(|p| p.as_object());
            if let Some(props) = props {
                for (k, ps) in props {
                    if let Some(v) = map.remove(k) {
                        map.insert(k.clone(), coerce_with_schema(v, ps));
                    }
                }
            }
            if let Some(ap) = schema.get("additionalProperties").filter(|v| v.is_object()) {
                let defined: Vec<String> = props.map(|p| p.keys().cloned().collect()).unwrap_or_default();
                let keys: Vec<String> = map.keys().filter(|k| !defined.contains(k)).cloned().collect();
                for k in keys {
                    if let Some(v) = map.remove(&k) {
                        map.insert(k, coerce_with_schema(v, ap));
                    }
                }
            }
        }
    }

    if types.contains(&"array") {
        if let Value::Array(items) = &mut next {
            match schema.get("items") {
                Some(Value::Array(tuple)) => {
                    for (i, item) in items.iter_mut().enumerate() {
                        if let Some(s) = tuple.get(i) {
                            *item = coerce_with_schema(item.take(), s);
                        }
                    }
                }
                Some(s) if s.is_object() => {
                    for item in items.iter_mut() {
                        *item = coerce_with_schema(item.take(), s);
                    }
                }
                _ => {}
            }
        }
    }
    next
}

/// Drop `null` for optional properties whose schema rejects null.
fn normalize_optional_nulls(value: &mut Value, schema: &Value) {
    if let Value::Array(items) = value {
        match schema.get("items") {
            Some(Value::Array(tuple)) => {
                for (i, item) in items.iter_mut().enumerate() {
                    if let Some(s) = tuple.get(i) {
                        normalize_optional_nulls(item, s);
                    }
                }
            }
            Some(s) if s.is_object() => {
                for item in items.iter_mut() {
                    normalize_optional_nulls(item, s);
                }
            }
            _ => {}
        }
        return;
    }
    let (Value::Object(map), Some(props)) = (value, schema.get("properties").and_then(|p| p.as_object())) else {
        return;
    };
    let required: Vec<&str> = schema
        .get("required")
        .and_then(|r| r.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    for (key, ps) in props {
        let Some(v) = map.get_mut(key) else { continue };
        if v.is_null() && !required.contains(&key.as_str()) && ps.get("$ref").is_none() && !validate(&Value::Null, ps, "").is_empty() {
            map.remove(key);
        } else {
            normalize_optional_nulls(v, ps);
        }
    }
}

fn join_path(base: &str, seg: &str) -> String {
    if base.is_empty() {
        seg.to_string()
    } else {
        format!("{base}.{seg}")
    }
}

/// Validate `value` against `schema`; returns `(path, message)` pairs.
pub fn validate(value: &Value, schema: &Value, path: &str) -> Vec<(String, String)> {
    let mut errors = Vec::new();
    let display_path = |p: &str| if p.is_empty() { "root".to_string() } else { p.to_string() };

    if let Some(all) = schema.get("allOf").and_then(|v| v.as_array()) {
        for s in all {
            errors.extend(validate(value, s, path));
        }
    }
    if let Some(any) = schema.get("anyOf").and_then(|v| v.as_array()) {
        if !any.iter().any(|s| validate(value, s, path).is_empty()) {
            errors.push((display_path(path), "Expected value to match one of the allowed schemas".into()));
        }
    }
    if let Some(one) = schema.get("oneOf").and_then(|v| v.as_array()) {
        let n = one.iter().filter(|s| validate(value, s, path).is_empty()).count();
        if n != 1 {
            errors.push((display_path(path), "Expected value to match exactly one of the allowed schemas".into()));
        }
    }
    if let Some(en) = schema.get("enum").and_then(|v| v.as_array()) {
        if !en.contains(value) {
            let allowed: Vec<String> = en.iter().map(|v| v.to_string()).collect();
            errors.push((display_path(path), format!("Expected one of: {}", allowed.join(", "))));
        }
    }
    if let Some(c) = schema.get("const") {
        if c != value {
            errors.push((display_path(path), format!("Expected {c}")));
        }
    }

    let types = schema_types(schema);
    if !types.is_empty() && !types.iter().any(|t| matches_json_type(value, t)) {
        errors.push((display_path(path), format!("Expected {}", types.join(" | "))));
        return errors;
    }

    match value {
        Value::Object(map) => {
            if let Some(req) = schema.get("required").and_then(|r| r.as_array()) {
                for r in req.iter().filter_map(|v| v.as_str()) {
                    if !map.contains_key(r) {
                        errors.push((join_path(path, r), "Expected required property".into()));
                    }
                }
            }
            let props = schema.get("properties").and_then(|p| p.as_object());
            if let Some(props) = props {
                for (k, ps) in props {
                    if let Some(v) = map.get(k) {
                        errors.extend(validate(v, ps, &join_path(path, k)));
                    }
                }
            }
            match schema.get("additionalProperties") {
                Some(Value::Bool(false)) => {
                    for k in map.keys() {
                        if !props.map_or(false, |p| p.contains_key(k)) {
                            errors.push((join_path(path, k), "Unexpected property".into()));
                        }
                    }
                }
                Some(ap) if ap.is_object() => {
                    for (k, v) in map {
                        if !props.map_or(false, |p| p.contains_key(k)) {
                            errors.extend(validate(v, ap, &join_path(path, k)));
                        }
                    }
                }
                _ => {}
            }
        }
        Value::Array(items) => {
            if let Some(min) = schema.get("minItems").and_then(|v| v.as_u64()) {
                if (items.len() as u64) < min {
                    errors.push((display_path(path), format!("Expected array length to be greater or equal to {min}")));
                }
            }
            if let Some(max) = schema.get("maxItems").and_then(|v| v.as_u64()) {
                if (items.len() as u64) > max {
                    errors.push((display_path(path), format!("Expected array length to be less or equal to {max}")));
                }
            }
            match schema.get("items") {
                Some(Value::Array(tuple)) => {
                    for (i, item) in items.iter().enumerate() {
                        if let Some(s) = tuple.get(i) {
                            errors.extend(validate(item, s, &join_path(path, &i.to_string())));
                        }
                    }
                }
                Some(s) if s.is_object() => {
                    for (i, item) in items.iter().enumerate() {
                        errors.extend(validate(item, s, &join_path(path, &i.to_string())));
                    }
                }
                _ => {}
            }
        }
        Value::String(s) => {
            let len = s.chars().count() as u64;
            if let Some(min) = schema.get("minLength").and_then(|v| v.as_u64()) {
                if len < min {
                    errors.push((display_path(path), format!("Expected string length greater or equal to {min}")));
                }
            }
            if let Some(max) = schema.get("maxLength").and_then(|v| v.as_u64()) {
                if len > max {
                    errors.push((display_path(path), format!("Expected string length less or equal to {max}")));
                }
            }
            if let Some(pat) = schema.get("pattern").and_then(|v| v.as_str()) {
                if let Ok(re) = regex::Regex::new(pat) {
                    if !re.is_match(s) {
                        errors.push((display_path(path), format!("Expected string to match '{pat}'")));
                    }
                }
            }
        }
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            if let Some(min) = schema.get("minimum").and_then(|v| v.as_f64()) {
                if f < min {
                    errors.push((display_path(path), format!("Expected number to be greater or equal to {min}")));
                }
            }
            if let Some(max) = schema.get("maximum").and_then(|v| v.as_f64()) {
                if f > max {
                    errors.push((display_path(path), format!("Expected number to be less or equal to {max}")));
                }
            }
            if let Some(min) = schema.get("exclusiveMinimum").and_then(|v| v.as_f64()) {
                if f <= min {
                    errors.push((display_path(path), format!("Expected number to be greater than {min}")));
                }
            }
            if let Some(max) = schema.get("exclusiveMaximum").and_then(|v| v.as_f64()) {
                if f >= max {
                    errors.push((display_path(path), format!("Expected number to be less than {max}")));
                }
            }
        }
        _ => {}
    }
    errors
}

/// Validate (and coerce) tool-call arguments against the tool's schema.
/// Returns the coerced arguments, or a formatted error message.
pub fn validate_tool_arguments(tool: &Tool, tool_call: &ToolCall) -> Result<Value, String> {
    let mut args = tool_call.arguments.clone();
    if args.is_null() {
        args = Value::Object(Map::new());
    }
    normalize_optional_nulls(&mut args, &tool.parameters);
    let coerced = coerce_with_schema(args, &tool.parameters);
    let errors = validate(&coerced, &tool.parameters, "");
    if errors.is_empty() {
        return Ok(coerced);
    }
    let lines: Vec<String> = errors.iter().map(|(p, m)| format!("  - {p}: {m}")).collect();
    Err(format!(
        "Validation failed for tool \"{}\":\n{}\n\nReceived arguments:\n{}",
        tool_call.name,
        lines.join("\n"),
        serde_json::to_string_pretty(&tool_call.arguments).unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(params: Value) -> Tool {
        Tool {
            name: "t".into(),
            description: "d".into(),
            parameters: params,
        }
    }

    fn call(args: Value) -> ToolCall {
        ToolCall {
            id: "1".into(),
            name: "t".into(),
            arguments: args,
            thought_signature: None,
            namespace: None,
        }
    }

    #[test]
    fn accepts_valid_and_coerces() {
        let t = tool(json!({
            "type":"object",
            "properties":{
                "path":{"type":"string"},
                "limit":{"type":"integer"},
                "force":{"type":"boolean"},
                "mode":{"type":"string","enum":["a","b"]}
            },
            "required":["path"]
        }));
        let out = validate_tool_arguments(&t, &call(json!({"path":"x","limit":"5","force":"true","mode":"a"}))).unwrap();
        assert_eq!(out, json!({"path":"x","limit":5,"force":true,"mode":"a"}));
    }

    #[test]
    fn drops_optional_null() {
        let t = tool(json!({"type":"object","properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["a"]}));
        let out = validate_tool_arguments(&t, &call(json!({"a":"x","b":null}))).unwrap();
        assert_eq!(out, json!({"a":"x"}));
    }

    #[test]
    fn reports_missing_required_and_bad_enum() {
        let t = tool(json!({"type":"object","properties":{"a":{"type":"string"},"m":{"type":"string","enum":["x"]}},"required":["a"]}));
        let err = validate_tool_arguments(&t, &call(json!({"m":"y"}))).unwrap_err();
        assert!(err.contains("Validation failed for tool \"t\""));
        assert!(err.contains("- a: Expected required property"));
        assert!(err.contains("- m: Expected one of"));
        assert!(err.contains("Received arguments"));
    }

    #[test]
    fn nested_arrays_and_unions() {
        let t = tool(json!({
            "type":"object",
            "properties":{
                "items":{"type":"array","items":{"type":"object","properties":{"n":{"type":"number"}},"required":["n"]}},
                "v":{"anyOf":[{"type":"string"},{"type":"number"}]}
            }
        }));
        let out = validate_tool_arguments(&t, &call(json!({"items":[{"n":"1.5"}],"v":3}))).unwrap();
        assert_eq!(out, json!({"items":[{"n":1.5}],"v":3}));
        let err = validate_tool_arguments(&t, &call(json!({"items":[{}]}))).unwrap_err();
        assert!(err.contains("items.0.n"));
    }

    #[test]
    fn null_args_become_empty_object() {
        let t = tool(json!({"type":"object","properties":{}}));
        assert_eq!(validate_tool_arguments(&t, &call(Value::Null)).unwrap(), json!({}));
    }
}
