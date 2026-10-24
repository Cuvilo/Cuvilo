export const materialKinds: Record<string,string> = {resume:"简历",project:"项目经历",job:"岗位描述",knowledge:"知识资料",terms:"技术术语"};
export type MaterialSection = "personal" | "knowledge";
// Legacy records keep their kind and enabled state; this is a view, not migration.
export const materialSection = (kind:string):MaterialSection => ["knowledge","terms"].includes(kind)?"knowledge":"personal";

export const materialKindOptions=(section:MaterialSection)=>Object.entries(materialKinds).filter(([kind])=>materialSection(kind)===section);
