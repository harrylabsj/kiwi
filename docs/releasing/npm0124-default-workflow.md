# 0.12.4 默认发布流程合同

保持现portfolio-release.yml：manual dry-run（publish=false）→同immutable候选SHA的protected kiwi-release→原registry verify。仍为五个publisher，不新增scopefilter/channel；只有Kiwi与merchant-cloud升0.12.4，其他版本不升。已发布的DSH0.1.2/Catalog0.5.5/shopping-cli3.2.6按原流程幂等skip，历史registry字节不代表本轮新源；实际运行前应重核版本事实。

构建host固定Node22.22.3，以满足npm12.0.2自己的engine；运行target原>=22.19保持。normal官方npm12安装后用真实`npm --version`调用A106检查；build-once和quality在npmci之前，npm publisher及registry/rollback核验使用同工具版本。不关生命周期脚本、hooks或伪造UA，不跳过fullverify。CI quality名称、checks、权限和action fullSHA保持。

新cloud输入为`node scripts/build-npm-shipping.mjs`，不调用旧thin artifact的skip-build；随后`node scripts/smoke-cloud-artifact.mjs --json`、build-cloud-package、pack dedicated merchant-cloud路径及原candidate verifier。完整Pi/依赖/源hash/budget/文件守卫由新shippingbuilder及其验收负责；workflow契约测试不能代替完整包候选验收、真实CI或平台冷启动。

build/sign一次；publisher下载同一不可变artifact，保持manifest核验、OIDC TrustedPublisher、provenance、protected环境与真人review，不在publish重新build。不得token绕OIDC或改reviewers、environment、ref、安全审批。发布后的原registry核验保fresh/历史skip区别。

本地契约验证不申请CI/部署approval。已只读证实环境kiwi-release有required reviewer harrylabsj及protected_branches=true；这不表示本次真人审批已完成。npm TrustedPublisher当前映射没有从公开registry字段得到完整设置证据；必须由真正默认流程验证，旧provenance存在不等于当前映射已证。

WorkBuddy所有已在审资产不得撤回、覆盖或重送；只可先做本地新版pin/SRI候选，旧审批成功后才允许提交新版审核。npm发布成功和heartbeat不算平台升级或新审核许可。生产服务升级单独授权。


R1：build-once中央checkout与quality中央checkout保留完整history，满足source guard对e703祖先的真实校验；不跳ancestry，也不fetch动态shell中的用户ref。build-once保持npmci，然后调用verify-npm-shipping-source.mjs；wrapper实际调用原npm run verify全部检查，只成功才记录fullverify日志/同源工具与dist receipt。随后原rootpack与newbuilder消费同一receipt，publish不重build。接线/合成wrapper测试不能冒真实fullverify/CI绿。


R1第三门：真实cloudpack与严格candidate verifier后、签名前调用verify-npm-shipping-installed.mjs。该脚本以同源receipt限定两个确切localtgz，正常npm12 --omit=dev cold安装到自有build路径，再实际CLI/import/合成签名permit+权威receipt正负/guardedSDK root，不提交模型；失败原throw停止，未ignore-scripts。provider fetch在合成runtime探针禁止，state只内存SQLite/自有临时目录，真实安装/包校验须独立验收，本workflow小控不代运行。


A410默认顺序：root fullverify receipt成功→独立early npm全部pack/strict/smoke/cold门→同run exact2 regular tgz path/size/SHA256/SRI checkpoint（build中wx）→所有consumer uv/Python/conformance→其他包/index/签名。late不rm已建release、不重npm pack/build；portfolio metadata在最后sourceassert之后才复制。Python/其他包结束后、index/SHA/sign前重核精确两包集合和digest，额外/缺失/软链/改bytes拒；不重新assertSource去豁免consumer已生成状态，不借跨run产物。checkpoint是同UID正常过程证据，不抗同UID恶意，同时保原release全manifest/cosign/五publisher的allchecks与真人门。


A410-R1 checkpoint显式检查cwd锚及固定release→npm→cloud每级lstat目录/nonlink。不得仅检查末级regular文件而跟随release父根symlink；原同run/SRI/五publisher/Python门不变。
