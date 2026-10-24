import type {Answer} from "@/types";
import {materialKinds} from "@/lib/material-kinds";
export function AnswerSources({answer,actions}:{answer:Answer;actions?:React.ReactNode}) {
  if(!answer.sources?.length)return actions?<div className="answer-footer-actions">{actions}</div>:null;
  return <div className="answer-footer"><details className="answer-sources"><summary>来源</summary><div>{answer.sources.map((source,index)=><section key={`${source.materialId}-${index}`}><h3>{source.title}<span>{materialKinds[source.kind]??"材料"}</span></h3><p>{source.excerpt}</p></section>)}</div></details><div className="answer-footer-actions">{actions}</div></div>;
}
