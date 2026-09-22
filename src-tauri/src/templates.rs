//! 提示词模板库（doc/优化方案/02 §1、03 §4，任务 T-Prompt）。
//!
//! 设计要点：
//! - 模板**持久化**到数据目录 `templates.json`（原子写），跨重启保留（验收：≥20 条自定义模板）
//! - `{变量名}` 插槽：保存时抽取变量清单，渲染时填值并回报缺失项，UI 可据此引导补填
//! - 内置模板不可删改：编辑内置模板等于"另存为"一份用户模板（避免升级时丢用户改动的归属判断）
//! - `TextGenPanel` 原先硬编码的 5 个模板迁到这里，成为 builtin

use crate::error::{code, GenError};
use crate::history::now_iso8601;
use crate::secret::{atomic_write, data_dir};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 用户可保存的模板条数上限（04 §8 参数上限的一层兜底）
pub const MAX_USER_TEMPLATES: usize = 300;
pub const MAX_BODY_CHARS: usize = 4_000;
const TEMPLATE_FILE: &str = "templates.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    /// text | image | video | ppt
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub variables: Vec<String>,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub favorite: bool,
    pub updated_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TemplateFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    templates: Vec<PromptTemplate>,
}

pub fn template_path() -> PathBuf {
    data_dir().join(TEMPLATE_FILE)
}

/// 抽取 `{变量}` 名，按出现顺序去重
pub fn extract_variables(body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let bytes: Vec<char> = body.chars().collect();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != '{' {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        let mut name = String::new();
        while j < bytes.len() && bytes[j] != '}' {
            // 变量名只允许字母数字下划线中划线中文，遇到其它字符则视为非法字面量
            let c = bytes[j];
            if c.is_alphanumeric() || c == '_' || c == '-' {
                name.push(c);
                j += 1;
            } else {
                break;
            }
        }
        if j < bytes.len() && bytes[j] == '}' && !name.is_empty() {
            if seen.insert(name.clone()) {
                out.push(name);
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// 填充变量。返回（渲染结果，缺失的变量名）。
pub fn render(
    body: &str,
    values: &std::collections::HashMap<String, String>,
) -> (String, Vec<String>) {
    let mut missing = Vec::new();
    let mut out = body.to_string();
    for name in extract_variables(body) {
        match values.get(&name) {
            Some(v) => {
                out = out.replace(&format!("{{{name}}}"), v);
            }
            None => missing.push(name),
        }
    }
    (out, missing)
}

/// 模板存储：整份常驻内存 + 每次变更原子重写（条数量级为百，够用且比 JSONL 更好校验）
pub struct Store {
    path: PathBuf,
    items: Vec<PromptTemplate>,
    corrupted: bool,
}

impl Default for Store {
    fn default() -> Self {
        Self::open()
    }
}

impl Store {
    pub fn open() -> Self {
        Self::load_from(&template_path())
    }

    pub fn load_from(path: &Path) -> Self {
        if !path.exists() {
            let fresh = Self {
                path: path.to_path_buf(),
                items: builtin_templates(),
                corrupted: false,
            };
            // 首次运行即落盘，保证用户删掉某个内置模板后不会被"复活"
            let _ = fresh.persist();
            return fresh;
        }
        match std::fs::read_to_string(path) {
            Err(_) => Self {
                path: path.to_path_buf(),
                items: builtin_templates(),
                corrupted: true,
            },
            Ok(text) => match serde_json::from_str::<TemplateFile>(&text) {
                Ok(file) if !file.templates.is_empty() => Self {
                    path: path.to_path_buf(),
                    items: file.templates,
                    corrupted: false,
                },
                // 空列表是合法状态（用户把所有模板都删了）
                Ok(_) => Self {
                    path: path.to_path_buf(),
                    items: Vec::new(),
                    corrupted: false,
                },
                Err(_) => {
                    let _ = std::fs::copy(path, path.with_extension("json.bak"));
                    Self {
                        path: path.to_path_buf(),
                        items: builtin_templates(),
                        corrupted: true,
                    }
                }
            },
        }
    }

    #[cfg(test)]
    pub fn items(&self) -> &[PromptTemplate] {
        &self.items
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 载入时被跳过的损坏行数（02 §5 历史受损提示同款机制）
    pub fn dropped_lines(&self) -> usize {
        if self.corrupted {
            1
        } else {
            0
        }
    }

    fn persist(&self) -> Result<(), GenError> {
        let file = TemplateFile {
            version: 1,
            templates: self.items.clone(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| GenError::storage(format!("序列化模板失败: {e}")))?;
        atomic_write(&self.path, json.as_bytes())
            .map_err(|e| GenError::storage(format!("写入模板失败: {e}")))
    }

    /// 带关键词的检索（模板名与正文都参与匹配）
    pub fn search(&self, kind: Option<&str>, keyword: Option<&str>) -> Vec<PromptTemplate> {
        let k = kind.map(str::trim).filter(|s| !s.is_empty() && *s != "all");
        self.filter_items(k, keyword)
    }

    fn filter_items(&self, kind: Option<&str>, keyword: Option<&str>) -> Vec<PromptTemplate> {
        let kw = keyword
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase());
        self.items
            .iter()
            .filter(|t| kind.map(|k| t.kind == k).unwrap_or(true))
            .filter(|t| match &kw {
                None => true,
                Some(k) => t.name.to_lowercase().contains(k) || t.body.to_lowercase().contains(k),
            })
            .cloned()
            .collect::<Vec<_>>()
            .sorted_by_preference()
    }

    pub fn get(&self, id: &str) -> Option<PromptTemplate> {
        self.items.iter().find(|t| t.id == id).cloned()
    }

    /// 新增或更新。内置模板不可原地改：改内置 = 派生一份用户模板。
    pub fn upsert(
        &mut self,
        id: Option<&str>,
        name: &str,
        kind: &str,
        body: &str,
        favorite: Option<bool>,
    ) -> Result<PromptTemplate, GenError> {
        let name = name.trim();
        let body = body.trim_end();
        if name.is_empty() {
            return Err(GenError::new(code::INVALID_PARAM, "模板名不能为空"));
        }
        if body.is_empty() {
            return Err(GenError::new(code::INVALID_PARAM, "模板正文不能为空"));
        }
        if body.chars().count() > MAX_BODY_CHARS {
            return Err(GenError::new(
                code::INVALID_PARAM,
                format!(
                    "模板正文过长（{} 字），上限 {MAX_BODY_CHARS}",
                    body.chars().count()
                ),
            ));
        }
        if !["text", "image", "video", "ppt"].contains(&kind) {
            return Err(GenError::new(
                code::INVALID_PARAM,
                format!("不支持的模板类型：{kind}"),
            ));
        }
        let vars = extract_variables(body);

        // 先取索引：避免在 iter_mut 借用期间再调用 &mut self 的方法
        if let Some(id) = id.map(str::trim).filter(|s| !s.is_empty()) {
            let Some(idx) = self.items.iter().position(|t| t.id == id) else {
                return Err(GenError::new(
                    code::INVALID_PARAM,
                    format!("模板 {id} 不存在"),
                ));
            };

            if self.items[idx].builtin {
                // 内置模板不可原地改：另存为一份用户模板
                let derived = PromptTemplate {
                    id: unique_id(&self.items, &format!("{id}-custom")),
                    name: format!("{name}（副本）"),
                    kind: kind.to_string(),
                    body: body.to_string(),
                    variables: vars,
                    builtin: false,
                    favorite: favorite.unwrap_or(self.items[idx].favorite),
                    updated_at: now_iso8601(),
                };
                self.push_user(derived.clone())?;
                return Ok(derived);
            }

            {
                let existing = &mut self.items[idx];
                existing.name = name.to_string();
                existing.kind = kind.to_string();
                existing.body = body.to_string();
                existing.variables = vars;
                if let Some(f) = favorite {
                    existing.favorite = f;
                }
                existing.updated_at = now_iso8601();
            }
            self.persist()?;
            return Ok(self.items[idx].clone());
        }

        let created = PromptTemplate {
            id: unique_id(&self.items, &slug_id(name)),
            name: name.to_string(),
            kind: kind.to_string(),
            body: body.to_string(),
            variables: vars,
            builtin: false,
            favorite: favorite.unwrap_or(false),
            updated_at: now_iso8601(),
        };
        self.push_user(created.clone())?;
        Ok(created)
    }

    fn push_user(&mut self, t: PromptTemplate) -> Result<(), GenError> {
        let user_count = self.items.iter().filter(|x| !x.builtin).count();
        if user_count >= MAX_USER_TEMPLATES {
            return Err(GenError::new(
                code::INVALID_PARAM,
                format!("自定义模板已达上限 {MAX_USER_TEMPLATES} 条，请先删除部分"),
            ));
        }
        self.items.insert(0, t);
        self.persist()
    }

    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<bool, GenError> {
        let Some(t) = self.items.iter_mut().find(|t| t.id == id) else {
            return Ok(false);
        };
        t.favorite = favorite;
        self.persist()?;
        Ok(true)
    }

    /// 删除模板。内置模板不允许删（它们是产品默认能力，删了会在下次升级时说不清状态）。
    pub fn delete(&mut self, id: &str) -> Result<bool, GenError> {
        let Some(idx) = self.items.iter().position(|t| t.id == id) else {
            return Ok(false);
        };
        if self.items[idx].builtin {
            return Err(GenError::new(
                code::INVALID_PARAM,
                "内置模板不可删除，可以另存为自己的版本",
            ));
        }
        self.items.remove(idx);
        self.persist()?;
        Ok(true)
    }

    /// 渲染某个模板；缺失变量会回列表而不报错（UI 提示补填）
    pub fn render(
        &self,
        id: &str,
        values: &std::collections::HashMap<String, String>,
    ) -> Result<Rendered, GenError> {
        let t = self
            .get(id)
            .ok_or_else(|| GenError::new(code::INVALID_PARAM, "模板不存在"))?;
        let (text, missing) = render(&t.body, values);
        Ok(Rendered {
            template_id: t.id,
            kind: t.kind,
            text,
            missing,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Rendered {
    pub template_id: String,
    pub kind: String,
    pub text: String,
    pub missing: Vec<String>,
}

trait SortedByPreference {
    fn sorted_by_preference(self) -> Vec<PromptTemplate>;
}

impl SortedByPreference for Vec<PromptTemplate> {
    /// 收藏优先，其次按更新时间新→旧
    fn sorted_by_preference(mut self) -> Vec<PromptTemplate> {
        // updated_at 是 ISO8601，字典序即时间序
        self.sort_by(|a, b| {
            b.favorite
                .cmp(&a.favorite)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        self
    }
}

fn slug_id(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "tpl".to_string()
    } else {
        cleaned
    }
}

fn unique_id(items: &[PromptTemplate], base: &str) -> String {
    if !items.iter().any(|t| t.id == base) {
        return base.to_string();
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !items.iter().any(|t| t.id == candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// 内置模板：前 5 条来自原 `TextGenPanel` 的硬编码 `promptTemplates`
fn builtin_templates() -> Vec<PromptTemplate> {
    let seed: [(&str, &str, &str); 8] = [
        (
            "builtin-article",
            "text",
            "请写一篇关于「{主题}」的文章，要求结构清晰、内容丰富，字数约 {字数} 字：\n\n{正文}",
        ),
        (
            "builtin-copywriting",
            "text",
            "请为「{产品/服务}」撰写营销文案，要求吸引眼球、突出卖点，投放渠道：{渠道}：\n\n{正文}",
        ),
        (
            "builtin-summary",
            "text",
            "请将以下内容总结为简洁的摘要，保留核心要点，控制在 {字数} 字内：\n\n{正文}",
        ),
        (
            "builtin-translate",
            "text",
            "请将以下内容翻译为{目标语言}并润色：\n\n{正文}",
        ),
        ("builtin-free", "text", "{正文}"),
        (
            "builtin-image-photo",
            "image",
            "{主体}，柔和自然光，浅景深，胶片质感，{色调}色调",
        ),
        (
            "builtin-image-flat",
            "image",
            "{主体}，扁平插画风格，简洁几何形状，有限配色，大色块",
        ),
        (
            "builtin-image-product",
            "image",
            "{产品}产品图，纯白背景，柔光箱打光，微距质感，商业摄影级细节",
        ),
    ];
    seed.iter()
        .map(|(id, kind, body)| PromptTemplate {
            id: id.to_string(),
            name: id.trim_start_matches("builtin-").to_string(),
            kind: kind.to_string(),
            body: body.to_string(),
            variables: extract_variables(body),
            builtin: true,
            favorite: false,
            updated_at: now_iso8601(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn extracts_variables_in_first_seen_order() {
        let v = extract_variables("主题{主题}，再来一次{主题}，字数{字数}，尾{ 非法}");
        assert_eq!(v, vec!["主题".to_string(), "字数".to_string()]);
        assert!(extract_variables("没有插槽").is_empty());
        assert!(extract_variables("{ }").is_empty());
    }

    #[test]
    fn render_fills_and_reports_missing() {
        let body = "{主体}在{场景}，风格{风格}";
        let (text, missing) = render(body, &values(&[("主体", "橘猫"), ("场景", "窗台")]));
        assert_eq!(text, "橘猫在窗台，风格{风格}");
        assert_eq!(missing, vec!["风格".to_string()]);
        let (full, none) = render(
            body,
            &values(&[("主体", "a"), ("场景", "b"), ("风格", "c")]),
        );
        assert_eq!(full, "a在b，风格c");
        assert!(none.is_empty());
    }

    #[test]
    fn builtins_are_seeded_and_persisted_on_first_run() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let store = Store::open();
        assert!(store.len() >= 8, "内置模板数 {} 偏少", store.len());
        assert!(store.items().iter().all(|t| t.builtin));
        // 原硬编码的 5 个文本模板必须都在
        for id in [
            "builtin-article",
            "builtin-copywriting",
            "builtin-summary",
            "builtin-translate",
            "builtin-free",
        ] {
            assert!(store.get(id).is_some(), "缺少内置模板 {id}");
        }
        assert!(template_path().exists(), "首次运行应落盘模板文件");
        // 落盘文件里已含内置模板 → 再次打开不重复注入
        let again = Store::open();
        assert_eq!(again.len(), store.len());
    }

    #[test]
    fn user_templates_survive_restart() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let mut store = Store::open();
        let mine = store
            .upsert(
                None,
                "我的周报",
                "text",
                "本周完成 {事项}，下周计划 {计划}",
                None,
            )
            .unwrap();
        // 中文名 slug 不出 ASCII id，退化成 tpl / tpl-2
        assert_eq!(mine.id, "tpl");

        let reopened = Store::open();
        assert_eq!(reopened.len(), store.len());
        let persisted = reopened
            .search(Some("text"), None)
            .into_iter()
            .find(|t| t.name == "我的周报")
            .expect("自定义模板未持久化");
        assert!(!persisted.builtin);
        assert_eq!(
            persisted.variables,
            vec!["事项".to_string(), "计划".to_string()]
        );

        let second = store.upsert(None, "另一个中文", "text", "x", None).unwrap();
        assert_eq!(second.id, "tpl-2", "中文名模板必须各自独立");
    }

    #[test]
    fn validation_rejects_bad_templates() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let mut store = Store::open();
        assert_eq!(
            store
                .upsert(None, "  ", "text", "x", None)
                .expect_err("must fail")
                .code,
            code::INVALID_PARAM
        );
        assert!(
            store.upsert(None, "n", "text", "   ", None).is_err(),
            "空正文"
        );
        assert!(
            store.upsert(None, "n", "other", "x", None).is_err(),
            "非法类型"
        );
        let long = "字".repeat(MAX_BODY_CHARS + 1);
        assert!(
            store.upsert(None, "n", "text", &long, None).is_err(),
            "超长正文"
        );
    }

    #[test]
    fn editing_builtin_creates_a_copy_instead_of_mutating() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let mut store = Store::open();
        let created = store
            .upsert(
                Some("builtin-article"),
                "我的文章模板",
                "text",
                "改写过的 {主题}",
                None,
            )
            .unwrap();
        assert!(!created.builtin, "派生模板必须是用户模板");
        let still = store.get("builtin-article").expect("内置模板必须还在");
        assert!(still.builtin);
        assert!(still.body.contains("字数"), "内置模板正文被改坏了");
        assert!(store.get(&created.id).is_some());
    }

    #[test]
    fn delete_blocks_builtin_and_persists() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let mut store = Store::open();
        assert!(store.delete("builtin-summary").is_err(), "内置模板不可删");
        let mine = store.upsert(None, "待删", "text", "x", None).unwrap();
        let before = store.len();
        assert!(store.delete(&mine.id).unwrap());
        assert_eq!(store.len(), before - 1);
        assert!(
            !Store::open().items().iter().any(|t| t.id == mine.id),
            "删除未落盘"
        );
        assert!(!store.delete("nope").unwrap());
    }

    #[test]
    fn favorite_and_ordering() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let mut store = Store::open();
        let a = store.upsert(None, "a", "text", "1", None).unwrap();
        store.upsert(None, "b", "text", "2", None).unwrap();
        assert!(store.set_favorite(&a.id, true).unwrap());
        assert!(!store.set_favorite("ghost", true).unwrap());
        let listed = store.search(None, None);
        assert_eq!(listed[0].id, a.id, "收藏的模板必须排在最前");
        assert!(Store::open().get(&a.id).unwrap().favorite, "收藏未持久化");
    }

    #[test]
    fn list_filters_by_kind_and_keyword() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let store = Store::open();
        let images = store.search(Some("image"), None);
        assert!(images.iter().all(|t| t.kind == "image"));
        assert!(images.len() >= 2);
        let by_kw = store.filter_items(None, Some("柔和自然光"));
        assert!(by_kw.iter().any(|t| t.id == "builtin-image-photo"));
        let by_name = store.filter_items(None, Some("周报"));
        assert!(by_name.is_empty(), "内置模板里没有「周报」");
        // 关键词同时匹配模板名：中文模板名不该被类型过滤掉
        let mut with_cn = Store::open();
        with_cn
            .upsert(None, "年度总结", "text", "模板正文", None)
            .unwrap();
        assert!(with_cn
            .filter_items(Some("text"), Some("年度总结"))
            .iter()
            .any(|t| t.name == "年度总结"));
        assert_eq!(store.search(Some("all"), None).len(), store.len());
    }

    #[test]
    fn user_template_cap_is_enforced() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let mut store = Store::open();
        for i in 0..MAX_USER_TEMPLATES {
            store
                .upsert(None, &format!("t{i}"), "text", "body", None)
                .unwrap();
        }
        let err = store
            .upsert(None, "overflow", "text", "body", None)
            .expect_err("must cap");
        assert_eq!(err.code, code::INVALID_PARAM);
        assert!(err.message.contains("上限"), "{}", err.message);
    }

    #[test]
    fn corrupt_file_is_backed_up_not_fatal() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        std::fs::create_dir_all(data_dir()).unwrap();
        std::fs::write(template_path(), b"{ not json").unwrap();
        let store = Store::open();
        assert_eq!(store.dropped_lines(), 1);
        assert!(store.len() >= 8, "损坏后必须回到内置种子");
        assert!(template_path().with_extension("json.bak").exists());
    }

    #[test]
    fn render_command_reports_missing_variables() {
        let _sb = crate::secret::test_sandbox::Sandbox::new();
        let store = Store::open();
        let out = store
            .render("builtin-image-photo", &values(&[("主体", "橘猫")]))
            .unwrap();
        assert_eq!(out.kind, "image");
        assert!(out.text.starts_with("橘猫，柔和自然光"));
        assert_eq!(out.missing, vec!["色调".to_string()]);
        assert!(store.render("ghost", &values(&[])).is_err());
    }

    #[test]
    fn unique_id_suffixes_on_collision() {
        let items = vec![PromptTemplate {
            id: "same".into(),
            name: "n".into(),
            kind: "text".into(),
            body: "b".into(),
            variables: vec![],
            builtin: false,
            favorite: false,
            updated_at: now_iso8601(),
        }];
        assert_eq!(unique_id(&items, "other"), "other");
        assert_eq!(unique_id(&items, "same"), "same-2");
    }
}
