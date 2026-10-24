//! Local, bounded material retrieval. No network calls or generated summaries.
use crate::types::{Material, MaterialSource};
use std::collections::HashSet;

pub struct MaterialContext {
    pub text: String,
    pub sources: Vec<MaterialSource>,
}
fn take(text: &str, limit: usize) -> String { text.chars().take(limit).collect() }
fn terms(query: &str) -> Vec<String> {
    static JIEBA: std::sync::OnceLock<jieba_rs::Jieba> = std::sync::OnceLock::new();
    let query=take(query,6000).to_lowercase();
    let mut seen=HashSet::new();
    JIEBA.get_or_init(jieba_rs::Jieba::new).cut_for_search(&query,false).into_iter()
        .filter(|w|w.chars().count()>1&&w.chars().any(char::is_alphanumeric))
        .filter(|w|!matches!(*w,"什么"|"怎么"|"如何"|"一下"|"请问"|"介绍"|"一个"|"哪些"|"为什么"|"可以"|"说明"|"问题"|"截图"|"提问"|"以及"|"简述"|"进行"|"我们"|"你们"|"详细"))
        .filter(|w|seen.insert((*w).to_string())).take(128).map(str::to_owned).collect()
}
fn score(text: &str, title: &str, terms: &[String]) -> usize {
    let text=text.to_lowercase();let title=title.to_lowercase();
    terms.iter().map(|term|text.matches(term).count().min(2)*2+usize::from(title.contains(term))*3).sum()
}
// End on a paragraph/sentence where possible. An 80-character overlap keeps a
// boundary-spanning condition available without copying entire documents.
fn chunks(text: &str) -> Vec<String> {
    let chars:Vec<_>=text.chars().collect();let mut start=0;let mut out=Vec::new();
    while start<chars.len() {
        let hard=(start+640).min(chars.len());
        let end=if hard==chars.len(){hard}else{(start+240..hard).rev().find(|&i|matches!(chars[i],'\n'|'。'|'！'|'？'|';'|'；')).map(|i|i+1).unwrap_or(hard)};
        let value:String=chars[start..end].iter().collect();
        if !value.trim().is_empty(){out.push(value.trim().to_owned());}
        if end==chars.len(){break;}
        start=end.saturating_sub(80).max(start+1);
    }
    out
}
fn source(m:&Material,excerpt:String)->MaterialSource {
    MaterialSource{material_id:m.id.clone(),title:take(&m.title,160),kind:m.kind.clone(),excerpt}
}
fn normalize(text:&str)->String{text.chars().filter(|c|!c.is_whitespace()).flat_map(char::to_lowercase).collect()}
fn append(text:&mut String,sources:&mut Vec<MaterialSource>,label:&str,item:MaterialSource){
    if !text.is_empty(){text.push_str("\n\n");}
    text.push_str(&format!("【{}：{}】\n{}",label,item.title,item.excerpt));sources.push(item);
}

pub fn material_context(materials:&[Material],question:&str,job:&str)->MaterialContext {
    let query=terms(question);let mut sources=Vec::new();let mut text=String::new();
    // Resume facts remain available even for a question with no shared keywords.
    // Personal projects get relevance ordering, but retain their original kind.
    let mut personal:Vec<_>=materials.iter().filter(|m|m.enabled&&matches!(m.kind.as_str(),"resume"|"project")).collect();
    personal.sort_by(|a,b|(b.kind=="resume").cmp(&(a.kind=="resume")).then_with(||score(&b.text,&b.title,&query).cmp(&score(&a.text,&a.title,&query))).then_with(||b.updated_at.cmp(&a.updated_at)).then_with(||a.id.cmp(&b.id)));
    let mut budget=3200;let mut seen=HashSet::new();
    for m in personal.into_iter().take(4) {
        if budget==0{break;}
        let mut pieces=chunks(&m.text);if pieces.is_empty(){continue;}
        let first=pieces.remove(0);pieces.sort_by_key(|p|std::cmp::Reverse(score(p,"",&query)));
        let extra=pieces.into_iter().find(|p|score(p,"",&query)>0&&!first.contains(p));
        let excerpt=take(&format!("{}{}",first,extra.map(|s|format!("\n[…]\n{s}")).unwrap_or_default()),budget.min(1200));
        if !seen.insert(normalize(&excerpt)){continue;}
        budget-=excerpt.chars().count();append(&mut text,&mut sources,"个人背景",source(m,excerpt));
    }
    // An old JD is not implicitly the current job. Select at most one JD whose
    // content/title explicitly contains the current role; no data is migrated.
    let role=job.trim().to_lowercase();
    if !role.is_empty(){
        if let Some(m)=materials.iter().filter(|m|m.enabled&&m.kind=="job"&&(m.title.to_lowercase().contains(&role)||m.text.to_lowercase().contains(&role))).max_by_key(|m|m.updated_at){
            append(&mut text,&mut sources,"岗位参考",source(m,take(&m.text,800)));
        }
    }
    let mut candidates=Vec::new();
    if !query.is_empty(){for m in materials.iter().filter(|m|m.enabled&&matches!(m.kind.as_str(),"knowledge"|"terms")) {
        for (index,part) in chunks(&m.text).into_iter().enumerate(){
            let value=score(&part,&m.title,&query);
            // A title match alone may select unrelated pages in a large manual.
            if value>0&&score(&part,"",&query)>0{candidates.push((value,index,m,part));}
        }
    }}
    candidates.sort_by(|a,b|b.0.cmp(&a.0).then_with(||b.2.updated_at.cmp(&a.2.updated_at)).then_with(||a.2.id.cmp(&b.2.id)).then_with(||a.1.cmp(&b.1)));
    let mut selected:Vec<(String,usize)>=Vec::new();let mut fingerprints=Vec::<String>::new();let mut budget=2600;
    for (_,index,m,part) in candidates {
        if selected.len()>=5||budget<120{break;}
        // Adjacent windows overlap: keep the strongest, allow distant passages.
        if selected.iter().any(|(id,i)|id==&m.id&&i.abs_diff(index)<=1){continue;}
        let fingerprint=normalize(&part);
        if fingerprints.iter().any(|s|s==&fingerprint||s.contains(&fingerprint)||fingerprint.contains(s)){continue;}
        let excerpt=take(&part,budget);budget-=excerpt.chars().count();
        fingerprints.push(fingerprint);selected.push((m.id.clone(),index));
        append(&mut text,&mut sources,"知识参考（非个人经历）",source(m,excerpt));
    }
    MaterialContext{text,sources}
}

#[cfg(test)]mod tests{
 use super::*;
 fn m(id:&str,kind:&str,text:&str)->Material{Material{id:id.into(),title:id.into(),kind:kind.into(),text:text.into(),enabled:true,updated_at:1}}
 #[test]fn personal_facts_survive_unrelated_questions_but_disabled_never_leak(){
  let mut off=m("off","resume","禁用事实");off.enabled=false;
  let items=[m("简历","resume","负责结算服务"),m("经历","project","实施订单改造"),off,m("知识","knowledge","Redis 缓存穿透")];
  let c=material_context(&items,"谈谈公平锁","后端工程师");assert!(c.text.contains("负责结算"));assert!(c.text.contains("订单改造"));assert!(!c.text.contains("禁用事实"));assert!(!c.text.contains("缓存穿透"));assert_eq!(c.sources.len(),2);
 }
 #[test]fn knowledge_is_case_insensitive_relevant_and_deduplicated(){
  let c=material_context(&[m("a","knowledge","Redis 布隆过滤器防止缓存穿透"),m("b","terms","Redis 布隆过滤器防止缓存穿透"),m("c","knowledge","Vue 组件生命周期")],"REDIS缓存穿透怎么解决？","");
  assert_eq!(c.sources.len(),1);assert!(c.text.contains("非个人经历"));assert!(c.sources[0].excerpt.contains("布隆"));
  assert!(material_context(&[m("a","knowledge","Redis 缓存")],"截图提问","").sources.is_empty());
 }
 #[test]fn title_alone_does_not_pull_in_unrelated_pages_and_jd_matches_current_role(){
  let c=material_context(&[m("Redis","knowledge","Flex 网格布局"),m("前端岗位","job","招募前端工程师"),m("后端岗位","job","招募后端工程师")],"Redis", "后端工程师");
  assert_eq!(c.sources.len(),1);assert_eq!(c.sources[0].material_id,"后端岗位");
 }
 #[test]fn boundaries_overlap_and_budgets_are_bounded_without_mutation(){
  let source_text=format!("{}。\nRedis {}。{}", "段落".repeat(160),"缓存".repeat(160),"说明".repeat(800));
  let parts=chunks(&source_text);assert!(parts.len()>2);assert!(parts.iter().all(|p|p.chars().count()<=640));
  let materials:Vec<_>=(0..20).map(|i|m(&i.to_string(),if i<10{"project"}else{"knowledge"},&format!("{i} {source_text}"))).collect();
  let old=serde_json::to_string(&materials).unwrap();let c=material_context(&materials,"Redis缓存","");
  assert!(c.sources.iter().filter(|s|s.kind=="project").map(|s|s.excerpt.chars().count()).sum::<usize>()<=3200);
  assert!(c.sources.iter().filter(|s|s.kind=="knowledge").map(|s|s.excerpt.chars().count()).sum::<usize>()<=2600);
  assert_eq!(old,serde_json::to_string(&materials).unwrap());
 }
 #[test]fn legacy_answers_load_without_sources_and_roundtrip_new_evidence(){
  let old=serde_json::json!({"id":"a","sessionId":"s","questionId":"q","revision":1,"question":"q","text":"t","status":"complete","mode":"short","createdAt":0,"speechEndAt":0,"triggerAt":0,"requestAt":0,"firstTokenMs":null,"firstSentenceMs":null});
  let mut answer:crate::types::Answer=serde_json::from_value(old).unwrap();assert!(answer.sources.is_empty());
  answer.sources=material_context(&[m("doc","knowledge","Redis 缓存")],"Redis","").sources;
  let loaded:crate::types::Answer=serde_json::from_str(&serde_json::to_string(&answer).unwrap()).unwrap();assert_eq!(loaded.sources[0].material_id,"doc");
 }
}
