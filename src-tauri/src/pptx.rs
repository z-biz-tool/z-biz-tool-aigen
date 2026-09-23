//! 真 `.pptx` 产物（doc/优化方案/01 B3、05 T-B3）。
//!
//! `.pptx` 本质是一个 OPC（zip + OOXML）包。这里手写最小但结构完整的演示文稿，
//! 不引第三方 SDK：`presentation.xml` + 一个母版/版式/主题 + N 张只有标题与正文的幻灯片。
//!
//! 注意：只保证结构符合 ECMA-376 的必需项，**不等于**在 PowerPoint 里逐像素美观；
//! 网页版式（`render_ppt_html`）仍然一并产出，作为"所见即所得"的预览与备选交付。

use crate::error::{code, GenError};
use std::io::{Cursor, Write};
use zip::write::SimpleFileOptions as FileOptions;
use zip::{CompressionMethod, ZipWriter};

/// 16:9 幻灯片尺寸（EMU）
const SLIDE_CX: i64 = 12_192_000;
const SLIDE_CY: i64 = 6_858_000;

/// PPT 生成的产物：网页预览 + 可交付的 .pptx
#[derive(Debug, Clone)]
pub struct Artifact {
    /// 可在浏览器直接打开的 HTML 预览（绝对路径）
    pub preview: String,
    /// 入库的结果引用，顺序固定为 [pptx, html]
    pub refs: Vec<String>,
}

/// 一页幻灯片
#[derive(Debug, Clone)]
pub struct Slide {
    pub title: String,
    /// 多行要点，一行一条
    pub body: String,
}

/// XML 文本转义（属性与元素内容通用）
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn zip_new(name: &str) -> String {
    format!("application/vnd.openxmlformats-officedocument.presentationml.{name}+xml")
}

fn content_types(slide_count: usize) -> String {
    let overrides: String = (1..=slide_count)
        .map(|i| {
            format!(
                "<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"{}\"/>",
                zip_new("slide")
            )
        })
        .collect();
    format!(
        r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="{pres}"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="{master}"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="{layout}"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="{theme}"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
{overrides}
</Types>"#,
        pres = zip_new("presentation"),
        master = zip_new("slideMaster"),
        layout = zip_new("slideLayout"),
        theme = "application/vnd.openxmlformats-officedocument.theme+xml",
        overrides = overrides,
    )
}

fn root_rels() -> String {
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#
        .to_string()
}

fn core_props(title: &str) -> String {
    format!(
        r#"<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>{t}</dc:title><dc:creator>z-biz-tool-aigen</dc:creator><cp:lastModifiedBy>z-biz-tool-aigen</cp:lastModifiedBy>
</cp:coreProperties>"#,
        t = esc(title)
    )
}

fn app_props(slide_count: usize) -> String {
    format!(
        r#"<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>z-biz-tool-aigen</Application><Slides>{n}</Slides><Company>z-biz-tool</Company>
</Properties>"#,
        n = slide_count
    )
}

/// `ppt/_rels/presentation.xml.rels`
fn presentation_rels(slide_count: usize) -> String {
    let rels: String = (1..=slide_count)
        .map(|i| {
            format!(
                "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{i}.xml\"/>",
                i + 1
            )
        })
        .collect();
    format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
{rels}
<Relationship Id="rId{theme}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>"#,
        rels = rels,
        theme = slide_count + 2
    )
}

/// `presentation.xml`：母版 + 幻灯片列表 + 尺寸
fn presentation(slide_count: usize) -> String {
    let ids: String = (1..=slide_count)
        .map(|i| format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 256 + i, i + 1))
        .collect();
    let pres = format!(
        r#"<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst maxSlideId="{max}">{ids}</p:sldIdLst>
<p:sldSz cx="{cx}" cy="{cy}"/><p:notesSz cx="{cy}" cy="{cx}"/>
</p:presentation>"#,
        ids = ids,
        max = 256 + slide_count,
        cx = SLIDE_CX,
        cy = SLIDE_CY,
    );
    pres
}

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;

/// 形状树必带的组属性（无插值，直接常量）
const GROUP_PROPS: &str = r#"<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>"#;

fn group_props() -> &'static str {
    GROUP_PROPS
}

/// 形状几何（EMU）
#[derive(Debug, Clone, Copy)]
struct Rect {
    x: i64,
    y: i64,
    cx: i64,
    cy: i64,
}

const TITLE_RECT: Rect = Rect {
    x: 520_000,
    y: 320_000,
    cx: SLIDE_CX - 1_040_000,
    cy: 1_200_000,
};
const BODY_RECT: Rect = Rect {
    x: 520_000,
    y: 1_680_000,
    cx: SLIDE_CX - 1_040_000,
    cy: SLIDE_CY - 2_000_000,
};

/// 一个带占位符的文本形状
fn text_shape(id: u32, name: &str, ph: &str, r: Rect, paragraphs: &str) -> String {
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="{ph}"/></p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/><a:lstStyle/>{paras}</p:txBody></p:sp>"#,
        id = id,
        name = esc(name),
        ph = ph,
        x = r.x,
        y = r.y,
        cx = r.cx,
        cy = r.cy,
        paras = paragraphs,
    )
}

/// 段落：一段一个 `<a:p>`，空段保留
fn paragraphs(body: &str, point_size: u32, bold: bool) -> String {
    let lines: Vec<&str> = if body.trim().is_empty() {
        vec![""]
    } else {
        body.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect()
    };
    lines
        .iter()
        .map(|l| {
            format!(
                r#"<a:p><a:pPr marL="228600" indent="-228600"{algn}><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="{sz}" b="{b}" dirty="0"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t>{t}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>"#,
                algn = if bold { " algn=\"ctr\"" } else { "" },
                sz = point_size * 100,
                b = if bold { 1 } else { 0 },
                t = esc(l),
            )
        })
        .collect()
}

fn slide_xml(slide: &Slide) -> String {
    let title = text_shape(
        2,
        "标题",
        "title",
        TITLE_RECT,
        &paragraphs(&slide.title, 36, true),
    );
    let body = text_shape(
        3,
        "内容",
        "body",
        BODY_RECT,
        &paragraphs(&slide.body, 20, false),
    );
    format!(
        r#"<p:sld {ns}><p:cSld><p:spTree>{grp}{title}{body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#,
        ns = NS,
        grp = group_props(),
        title = title,
        body = body,
    )
}

fn slide_rels() -> String {
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>"#
        .to_string()
}

fn slide_layout() -> String {
    format!(
        r#"<p:sldLayout {ns} type="blank" preserve="1"><p:cSld name="空白"><p:spTree>{grp}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#,
        ns = NS,
        grp = group_props()
    )
}

fn slide_layout_rels() -> String {
    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"#
        .to_string()
}

fn slide_master() -> String {
    let title_body_styles = r#"<p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>"#;
    format!(
        r#"<p:sldMaster {ns}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>{grp}{title_ph}{body_ph}</p:spTree></p:cSld>
<p:clrMap bg="1" tx1="1" bg1="2" tx2="3" hl1="4" hl2="5" dk1="lo1" lt1="lo2" dk2="dk1" lt2="lt1" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles>{styles}</p:txStyles></p:sldMaster>"#,
        ns = NS,
        grp = group_props(),
        title_ph = text_shape(2, "标题占位符", "title", TITLE_RECT, "<a:p/>"),
        body_ph = text_shape(3, "内容占位符", "body", BODY_RECT, "<a:p/>"),
        styles = title_body_styles,
    )
}

fn slide_master_rels(theme_rid_idx: usize) -> String {
    format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId{theme}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"#,
        theme = theme_rid_idx
    )
}

/// 主题：Office 主题的必需块（配色 12 项 + 字体 + 三种样式表）
fn theme() -> String {
    let colors = [
        ("dk1", "<a:sysClr val=\"windowText\" lastClr=\"000000\"/>"),
        ("lt1", "<a:sysClr val=\"window\" lastClr=\"FFFFFF\"/>"),
        ("dk2", "<a:srgbClr val=\"44546A\"/>"),
        ("lt2", "<a:srgbClr val=\"E7E6E6\"/>"),
        ("accent1", "<a:srgbClr val=\"667EEA\"/>"),
        ("accent2", "<a:srgbClr val=\"764BA2\"/>"),
        ("accent3", "<a:srgbClr val=\"4472C4\"/>"),
        ("accent4", "<a:srgbClr val=\"ED7D31\"/>"),
        ("accent5", "<a:srgbClr val=\"A5A5A5\"/>"),
        ("accent6", "<a:srgbClr val=\"FFC000\"/>"),
        ("hlink", "<a:srgbClr val=\"0563C1\"/>"),
        ("folHlink", "<a:srgbClr val=\"954F72\"/>"),
    ];
    let scheme: String = colors
        .iter()
        .map(|(name, val)| format!("<a:{name}>{val}</a:{name}>"))
        .collect();
    let fonts = r#"<a:fontScheme name="office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>"#;
    let fill = r#"<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill><a:noFill/></a:fillStyleLst>"#;
    let ln = r#"<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>"#;
    let effect = r#"<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"#;
    let bg = r#"<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>"#;
    format!(
        r#"<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="aigen"><a:themeElements><a:clrScheme name="aigen">{scheme}</a:clrScheme>{fonts}{fill}{ln}{effect}{bg}</a:themeElements></a:theme>"#,
        scheme = scheme
    )
}

/// 生成 `.pptx` 字节流
pub fn build(topic: &str, slides: &[Slide]) -> Result<Vec<u8>, GenError> {
    if slides.is_empty() {
        return Err(GenError::new(code::INVALID_PARAM, "没有可用的幻灯片页"));
    }
    let cursor = Cursor::new(Vec::new());
    let mut z = ZipWriter::new(cursor);
    let opts = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mut add = |name: &str, data: &str| -> Result<(), GenError> {
        z.start_file(name, opts)
            .map_err(|e| GenError::storage(format!("写入 {name} 失败: {e}")))?;
        z.write_all(data.as_bytes())
            .map_err(|e| GenError::storage(format!("写入 {name} 失败: {e}")))?;
        Ok(())
    };

    add("[Content_Types].xml", &content_types(slides.len()))?;
    add("_rels/.rels", &root_rels())?;
    add("docProps/core.xml", &core_props(topic))?;
    add("docProps/app.xml", &app_props(slides.len()))?;
    add("ppt/presentation.xml", &presentation(slides.len()))?;
    add(
        "ppt/_rels/presentation.xml.rels",
        &presentation_rels(slides.len()),
    )?;
    add("ppt/theme/theme1.xml", &theme())?;
    add("ppt/slideMasters/slideMaster1.xml", &slide_master())?;
    add(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        &slide_master_rels(2),
    )?;
    add("ppt/slideLayouts/slideLayout1.xml", &slide_layout())?;
    add(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        &slide_layout_rels(),
    )?;
    for (i, s) in slides.iter().enumerate() {
        add(&format!("ppt/slides/slide{}.xml", i + 1), &slide_xml(s))?;
        add(
            &format!("ppt/slides/_rels/slide{}.xml.rels", i + 1),
            &slide_rels(),
        )?;
    }

    let out = z
        .finish()
        .map_err(|e| GenError::storage(format!("打包 pptx 失败: {e}")))?;
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    fn deck() -> Vec<Slide> {
        vec![
            Slide {
                title: "2024 年度总结".into(),
                body: String::new(),
            },
            Slide {
                title: "做了什么".into(),
                body: "上线 3 个模块\n修 12 个 bug".into(),
            },
            Slide {
                title: "<脚本&注入>\"测试\"".into(),
                body: "&amp; 也要原样显示".into(),
            },
        ]
    }

    fn names(bytes: &[u8]) -> Vec<String> {
        let mut z = ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().to_string())
            .collect()
    }

    fn read_part(bytes: &[u8], name: &str) -> String {
        let mut z = ZipArchive::new(Cursor::new(bytes.to_vec())).unwrap();
        let mut f = z.by_name(name).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn builds_a_complete_opc_package() {
        let bytes = build("年度总结", &deck()).unwrap();
        let names = names(&bytes);
        for required in [
            "[Content_Types].xml",
            "_rels/.rels",
            "ppt/presentation.xml",
            "ppt/_rels/presentation.xml.rels",
            "ppt/slideMasters/slideMaster1.xml",
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            "ppt/slideLayouts/slideLayout1.xml",
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            "ppt/theme/theme1.xml",
            "ppt/slides/slide1.xml",
            "ppt/slides/slide2.xml",
            "ppt/slides/slide3.xml",
            "ppt/slides/_rels/slide3.xml.rels",
            "docProps/core.xml",
        ] {
            assert!(
                names.iter().any(|n| n == required),
                "缺少 {required}：{names:?}"
            );
        }
        // zip 注释里说得很清楚：结构完整不等于 PowerPoint 美观，这里只验结构与必需项
        assert!(bytes.starts_with(b"PK"), "不是 zip 包");
    }

    #[test]
    fn presentation_lists_every_slide_with_unique_rids() {
        let bytes = build("t", &deck()).unwrap();
        let pres = read_part(&bytes, "ppt/presentation.xml");
        let rels = read_part(&bytes, "ppt/_rels/presentation.xml.rels");
        assert_eq!(pres.matches("<p:sldId ").count(), 3);
        assert!(pres.contains(r#"cx="12192000""#));
        for i in 0..3 {
            assert!(
                rels.contains(&format!("Target=\"slides/slide{}.xml\"", i + 1)),
                "rels 缺 slide{}",
                i + 1
            );
        }
        // 母版 rId1 与幻灯片 rId 不能撞车
        assert!(rels.contains("Id=\"rId1\"") && rels.contains("Id=\"rId2\""));
        assert!(rels.contains("relationships/theme"));
    }

    #[test]
    fn content_types_declares_every_part() {
        let bytes = build("t", &deck()).unwrap();
        let ct = read_part(&bytes, "[Content_Types].xml");
        assert_eq!(ct.matches("/ppt/slides/slide").count(), 3);
        for part in [
            "/ppt/presentation.xml",
            "/ppt/slideMasters/slideMaster1.xml",
            "/ppt/slideLayouts/slideLayout1.xml",
            "/ppt/theme/theme1.xml",
            "/docProps/core.xml",
        ] {
            assert!(ct.contains(part), "Content_Types 缺 {part}");
        }
        assert!(ct.contains(r#"Extension="rels""#));
    }

    #[test]
    fn slide_text_is_escaped_and_split_into_paragraphs() {
        let bytes = build("t", &deck()).unwrap();
        let s3 = read_part(&bytes, "ppt/slides/slide3.xml");
        assert!(!s3.contains("<script>"), "未转义：{s3}");
        assert!(s3.contains("&lt;脚本&amp;注入&gt;"));
        let s2 = read_part(&bytes, "ppt/slides/slide2.xml");
        // 标题 1 段 + 两行要点 2 段
        assert_eq!(s2.matches("<a:p>").count(), 3, "段落切分不对：{s2}");
        assert!(s2.matches("•").count() >= 2, "要点应有项目符号");
        assert!(s2.contains("上线 3 个模块") && s2.contains("修 12 个 bug"));
    }

    /// 属性必须各自独立成对：曾经的真实 bug 是把 ` algn="ctr"` 拼进了 indent 的值里，
    /// 产出 `indent="-228600 algn="ctr""`，PowerPoint 会直接判定文件损坏。
    #[test]
    fn paragraph_properties_have_no_nested_quotes() {
        let xml = paragraphs("两行\n要点", 20, false);
        assert!(!xml.contains("\"\""), "出现连续引号：{xml}");
        assert!(!xml.contains("algn"), "正文不该带 algn");
        let title = paragraphs("标题", 36, true);
        assert!(
            title.contains(r#" indent="-228600" algn="ctr""#),
            "标题对齐写法不对：{title}"
        );
        assert!(
            !title.contains(r#"" algn""#),
            "属性嵌进了上一个值里：{title}"
        );
    }

    #[test]
    fn empty_deck_is_rejected_and_quotes_survive() {
        assert_eq!(
            build("t", &[]).expect_err("must fail").code,
            code::INVALID_PARAM
        );
        let bytes = build(
            "带\"引号\"的主题",
            &[Slide {
                title: "a\"b".into(),
                body: String::new(),
            }],
        )
        .unwrap();
        let core = read_part(&bytes, "docProps/core.xml");
        assert!(core.contains("&quot;"), "标题里的引号未转义：{core}");
    }
}
