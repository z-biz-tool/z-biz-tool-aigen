//! 生成一个可被外部工具检视的 .pptx 样本（结构自检 + 便于 `unzip`/Quick Look 人工验证）。
//! 断言只覆盖包结构与必需部件；"PowerPoint 能否完美渲染"无法在此证明，见 05 偏差 11。

use z_biz_tool_aigen_lib::pptx::{build, Slide};

#[test]
fn writes_a_sample_deck_for_external_inspection() {
    let slides = vec![
        Slide {
            title: "2026 年度技术总结".into(),
            body: String::new(),
        },
        Slide {
            title: "做了什么".into(),
            body: "统一生成入口 submit_generation\n密钥改为 XChaCha20Poly1305 加密落盘\n新增历史/模板/导出/批量".into(),
        },
        Slide {
            title: "风险与<转义>&测试".into(),
            body: "这一页用来验证特殊字符不会破坏 XML".into(),
        },
    ];
    let bytes = build("2026 年度技术总结", &slides).expect("build pptx");

    let dir = std::env::temp_dir().join("aigen-pptx-sample");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sample.pptx");
    std::fs::write(&path, &bytes).unwrap();
    println!("SAMPLE_PPTX={}", path.display());

    assert!(bytes.starts_with(b"PK"));
    // 至少能当 zip 打开，且关键部件齐备
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..z.len())
        .map(|i| z.by_index(i).unwrap().name().to_string())
        .collect();
    for required in [
        "[Content_Types].xml",
        "_rels/.rels",
        "ppt/presentation.xml",
        "ppt/slideMasters/slideMaster1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/theme/theme1.xml",
        "ppt/slides/slide3.xml",
    ] {
        assert!(names.iter().any(|n| n == required), "缺少 {required}");
    }
    // 用真正的 XML 解析器逐个部件走一遍（quick-xml 只作 dev 依赖，不进产物），
    // 并要求起始/结束标签配对：属性引号写错这类问题必须在这里被拦住
    let mut parsed = 0;
    for name in &names {
        if !name.ends_with(".xml") && !name.ends_with(".rels") {
            continue;
        }
        let data = {
            let mut f = z.by_name(name).unwrap();
            let mut s = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut s).unwrap();
            s
        };
        assert_well_formed(name, &data);
        assert_attributes_closed(name, &data);
        parsed += 1;
    }
    assert!(parsed >= 13, "只校验了 {parsed} 个部件，覆盖不足");
}

/// 良构性检查：开闭标签必须配对，属性必须成对引号
fn assert_well_formed(name: &str, data: &[u8]) {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_reader(data);
    reader.config_mut().check_end_names = true;
    let mut buf = Vec::new();
    let mut depth = 0usize;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(_)) => depth += 1,
            Ok(Event::Empty(_)) => {}
            Ok(Event::End(_)) => {
                assert!(depth > 0, "{name}: 多余的结束标签");
                depth -= 1;
            }
            Ok(Event::Eof) => break,
            Err(e) => panic!("{name} 不是良构 XML: {e}"),
            _ => {}
        }
        buf.clear();
    }
    assert_eq!(depth, 0, "{name}: 有 {depth} 个标签未闭合");
}

/// quick-xml 对属性引号很宽容（实测：把 `algn="ctr"` 拼进 `indent` 的值里它也不报错），
/// 所以再补一道严格的边界检查：每个属性值收尾的引号之后，必须紧跟空白、`/` 或 `>`。
/// 少了这一道，`indent="-228600 algn="ctr""` 这种会让 PowerPoint 判定文件损坏的写法能顺利溜过 CI。
fn assert_attributes_closed(name: &str, data: &[u8]) {
    let text = String::from_utf8_lossy(data);
    let mut rest: &str = &text;
    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let Some(close) = rest.find('>') else {
            panic!("{name}: 有未闭合的 '<'");
        };
        let tag = &rest[..close];
        rest = &rest[close + 1..];
        if tag.starts_with(['?', '!', '/']) {
            continue; // <?xml?>、注释、结束标签
        }

        let b = tag.as_bytes();
        let mut i = 0usize;
        while i < b.len() && !matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
            i += 1; // 元素名
        }
        while i < b.len() {
            while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
                i += 1;
            }
            if i >= b.len() {
                break;
            }
            if b[i] == b'/' {
                break; // 自闭合
            }
            let name_start = i;
            while i < b.len() && b[i] != b'=' && b[i] != b' ' {
                i += 1;
            }
            let attr = &tag[name_start..i];
            assert!(
                i < b.len() && b[i] == b'=',
                "{name}: 属性 `{attr}` 缺少值，标签=<{tag}>"
            );
            i += 1;
            assert!(
                i < b.len() && b[i] == b'"',
                "{name}: 属性 {attr} 的起始引号缺失，标签=<{tag}>"
            );
            i += 1;
            let val_start = i;
            while i < b.len() && b[i] != b'"' {
                i += 1;
            }
            assert!(
                i < b.len(),
                "{name}: 属性 {attr} 的引号未闭合，标签=<{tag}>"
            );
            let value = &tag[val_start..i];
            assert!(
                !value.contains('"'),
                "{name}: 属性 {attr} 的值里出现引号 → 值={value:?} 标签=<{tag}>"
            );
            i += 1;
            // 收尾引号之后必须紧跟空白、`/` 或标签结束；否则说明有引号被嵌进了值里
            if i < b.len() {
                assert!(
                    matches!(b[i], b' ' | b'\t' | b'\n' | b'\r' | b'/'),
                    "{name}: 属性 {attr} 值收尾后紧跟 {:?} → 值={value:?} 标签=<{tag}>",
                    b[i] as char
                );
            }
        }
    }
}
