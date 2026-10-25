import { AccessService } from '../../src/access/service';
/** Test credentials follow production consent, never revive broad authority. */
export async function delegatedKey(db: D1Database, p: {workspaceId:string;userId:string;name:string;domain:string;kind?:'human'|'service'}) {
 const actor={principalId:p.userId,kind:'human' as const,userId:p.userId,workspaceId:p.workspaceId,session:true,grants:[]};
 const service=new AccessService(db,actor), principal=await service.createPrincipal(p.workspaceId,p.name,p.kind ?? 'human');
 const expiresAt=Math.floor(Date.now()/1000)+3600;
 await service.grant({workspaceId:p.workspaceId,principalId:principal.id,domain:p.domain,actions:['resources:read','reports:read','metrics:read','diagnostics:run'],expiresAt});
 return service.issueCredential(p.workspaceId,principal.id,p.name,expiresAt);
}
