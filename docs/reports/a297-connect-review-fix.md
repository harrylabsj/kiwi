# A297 Connect评审最小修复

结论：授权Connect范围完成，最终4相关文件57/57实际exit0、tsc最终0。未main整合/push/安装/下载/cloudpack/Docker/平台/真实Catalog/model或费用；automation保持PAUSED。基线exact8a8e890efe50ccd39c2bcbd71e8ac80300913d12，owner/platform/sourcing/依赖锁0diff。

## 修复合同

2-1：CatalogClient共享verifyCatalogEnvelope真实配置Catalog HTTPS issuer-keys/JWK状态与实际thumb、compactJWS验签/protectedkid/完整schema/issuer/status/issued/expiry。使用签名payload；bind允许既有明文merchant/expiry摘要逐字段与signed一致（不是要求摘要假变全对象），public仍完整明文schema且与signed字段一致，错sig/kid/thumb/明文拒。public route/agent/cardurl及service本地binding/version/merchant/origin/endpoint/keyid/thumb/serviceepoch/cardrevision/expiry匹配，legacy缺merchant只在真实签名后回填，缺bindingversion拒。不声称防Catalog自己或其TLS/JWKS权威被攻破。host options.now原样传CatalogClient，缺省真实Date，绝不取claim里的时间当now。

2-2：短排他store RMW（wx+随机token、单调1秒有限等待），仅sync本地操作，不跨network/挑战回调。sessions私有store_revision CAS+内存Symbol observed snapshot digest，后者不序列化，捕获旧writer同revision改status/fields；保所有consumed/其它session。旧version1无revision按0首正常写升级，原会话不机械过期/迁移。

poll/bind/publish（含activate）持久stepclaim跨实例/进程，期望状态/revision/snapshot检查先于network；成功或已知尚未进入effect窗口安全释放。bind/发布/activate开始后网络失败留unknown，expired/未知claim不偷或重驱。新增creation effect claim同样先占后device请求，成功会话已落盘才按token释放；失败/unknown文件保留，不全程拿RMW锁。begin不能以新enrollment绕历史未知效果。没有public清锁/force/drop/retry API；恢复readiness前置失败可同session正常5秒续办，未知外部效果则需正常operator权威对账及明确后续恢复合同，当前不自动完成该人工流程。

challenge responder重新读当前authorized/bound/session/key/origin/expiry，consumed重查+追加同锁内；bind等待challenge时不持锁。token只能删除自己当前匹配的正常锁，未知owner/stale锁留，不删除他人活锁。任何创建fd在metadata写故障也finally关闭。

2-5/6：注册RUNTIME_UNREACHABLE/NOT_READY/IDENTITY_MISMATCH三安全码；bootstrap beforePublish readiness抛MerchantConnectError(CATALOG_RUNTIME_NOT_READY)，summary固定码、失败仍bound可恢复；原5秒retry未取消。

2-8：原Apache头保留。writeAtomic file fsync→close→rename→directory fsync，失败关闭fd/清自有temp；explicit options.mode优先/default0600原private语义，0644→要求0600实际收紧，无process.umask修改、无in-place chmod旧target。rename前故障旧target保持；dirsync失败已rename故committed=true/error，不能回滚或说旧文件还在。支持Mac实际本地sync；其它不支持directorysync的平台明确报错/committed未知durability，不暗skip。故障注入不证明真实断电。

## 实际验证及所有首次红

旁置原raw **/private/tmp/kiwi-a297-connect-review-evidence**，不入产品commit。

- 最终tests-final.raw.txt：原Connect28 + 相邻client21（原20正fixtures已真实Ed25519/JWKS，另原header.payload.sig reject1） + 新8承重 =57pass/0fail，exit0；build-confirm.raw.txt tsc0。
- 新例：坏签名实际signature位翻转不重签；明文/unknownkid/thumb错legacy backfill0write；合法signed可回填。两实例barrier拒重复poll、迟到pending CAS不能覆盖legacy同revision published。实际slow_down响应11秒节流。typedreadiness恢复同bound不重复bind。
- 两真实challenge子进程同nonce返回200/409且consumed1；另两真实publish子进程一Pending一Published，bind/publish/activate各1，beforePublish回调RMW marker与原consumed保留、不死锁。child10秒、IPC5秒、stop3秒，全部正常结束。
- lostbindreply bind1之后unknown claim，重启/过期不rebind/不newenrollment；concurrentbegin只devicecreate1。fs file-sync/rename错误旧bytes+temp清理，dir-sync错误新bytes/committedtrue，原umask不变；0644请求0600实际0600；锁metadatafault ownfdclose1/无callback/未知lock留。

首次Connect21红（成功claim未删除）、19红（合法bind摘要被误要求全payload）、1TTL红（client未接host模拟clock）均原样旁置保留，修产品不改旧expect；最终旧28恢复。client首5红是旧dummy签名/过期fixture，正fixture升级真实签名/现在hostclock，旧dummy明确负验，不让源码接受它。一次fd注入接口补写后的tsc2红也保留，最后修合法签名tsc0。没有旧红改写成exit0。

## 范围与未验

唯一产品5原文件+新store-lock，bootstrap仅typedreadiness import/throw。部分老长行经同项目现有Prettier规范，完整diff包含format-only；旁置semantic.diff提供忽略空白视图，不剪原raw。57例只是Connect相关，不是whole repo/完整生产流程/恶意同UID/网络exactly-once保证。未知claim人工处理/旧孤立锁恢复需权威事实，不提供假reset。物理复用依赖仍原node_modules，不新install，新的pkglock版本完整物理安装不在本单。

交root审候选+旁置报告后原非作者只增量2–4承重组，不自动再大矩阵、不push。

## A301后test-only类型修正

原352冻结保留，生产src字节不变。新增测试Response.json原unknown在57例Vitest运行不报但full tsconfig检查5项报错；原tsc.build只查src，不得冒fullTSC。只增加fixture对象/claims/signature类型运行时守卫，仍翻转原签名位、相同强assert；未asany/生产宽松。本作者树full `tsc -p tsconfig.json --noEmit` 实际exit0，旁置full-typecheck.raw.txt；受影响单一签名用例定向通过，其余57旧绿不重复。新commit仅test+本说明，root联合tree随后取此小差异。
