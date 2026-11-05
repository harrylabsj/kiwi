import {constants,closeSync,fsyncSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {isAbsolute,join} from 'node:path';

// Per-buyer-instance state. The host supplies CODEBUDDY_PLUGIN_DATA per plugin
// installation. We only use it as a parent container; the actual identity and
// buyer database live in a private child that is not tied to a Kiwi version
// cache. A shared parent is not treated as an isolated instance by itself.
const INSTANCE_DIR='kiwi-instance-v1';
const ID_FILE='instance-id';
const TOKEN_FILE='session.token';
const DB_FILE='buyer.sqlite';
const HEX64=/^[0-9a-f]{64}$/;

function fail(code){const error=new Error(code);error.code=code;throw error}
function uid(){return typeof process.getuid==='function'?process.getuid():null}
function privateDir(path){
  let stat;try{stat=lstatSync(path)}catch{fail('INSTANCE_DATA_UNAVAILABLE')}
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||(uid()!==null&&stat.uid!==uid()))fail('INSTANCE_DATA_NOT_PRIVATE');
  return path;
}
function readPrivate(path,max){
  let fd;
  try{
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o077)!==0||(uid()!==null&&stat.uid!==uid())||stat.size>max)fail('INSTANCE_DATA_NOT_PRIVATE');
    return readFileSync(fd,'utf8');
  }catch(error){if(error?.code&&String(error.code).startsWith('INSTANCE_'))throw error;if(error?.code==='ENOENT')fail('INSTANCE_STATE_INCOMPLETE');fail('INSTANCE_DATA_NOT_PRIVATE')}
  finally{if(fd!==undefined)closeSync(fd)}
}
function writePrivate(path,value){
  let fd;
  try{
    fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,value,{encoding:'utf8'});
    fsyncSync(fd);
  }catch(error){if(error?.code==='EEXIST')fail('INSTANCE_STATE_CONFLICT');fail('INSTANCE_DATA_UNAVAILABLE')}
  finally{if(fd!==undefined)closeSync(fd)}
}
function validateInstance(root){
  privateDir(root);
  const instanceId=readPrivate(join(root,ID_FILE),128).trim();
  const token=readPrivate(join(root,TOKEN_FILE),128).trim();
  if(!HEX64.test(instanceId)||!HEX64.test(token))fail('INSTANCE_STATE_CORRUPT');
  const dbPath=join(root,DB_FILE);
  try{
    const stat=lstatSync(dbPath);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||(uid()!==null&&stat.uid!==uid()))fail('INSTANCE_DATA_NOT_PRIVATE');
  }catch(error){if(error?.code!=='ENOENT')throw error}
  return Object.freeze({root,instanceId,tokenFile:join(root,TOKEN_FILE),dbPath});
}
function createInstance(root){
  const temp=join(root,'..',`.${INSTANCE_DIR}-${randomBytes(12).toString('hex')}`);
  try{
    mkdirSync(temp,{mode:0o700});
    privateDir(temp);
    writePrivate(join(temp,ID_FILE),randomBytes(32).toString('hex'));
    writePrivate(join(temp,TOKEN_FILE),randomBytes(32).toString('hex'));
    // Directory rename publishes identity + token together; no reader can
    // observe a half-initialized instance root.
    renameSync(temp,root);
  }catch(error){
    try{rmSync(temp,{recursive:true,force:true})}catch{void 0}
    if(error?.code==='EEXIST'||error?.code==='ENOTEMPTY')return validateInstance(root);
    throw error;
  }
  return validateInstance(root);
}

export function prepareInstanceData(pluginData){
  if(typeof pluginData!=='string'||!isAbsolute(pluginData))fail('INSTANCE_DATA_UNAVAILABLE');
  let real;try{real=realpathSync(pluginData)}catch{fail('INSTANCE_DATA_UNAVAILABLE')}
  if(real!==pluginData)fail('INSTANCE_DATA_UNAVAILABLE');
  let parent;try{parent=lstatSync(pluginData)}catch{fail('INSTANCE_DATA_UNAVAILABLE')}
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o022)!==0||(uid()!==null&&parent.uid!==uid()))fail('INSTANCE_DATA_NOT_PRIVATE');
  const root=join(pluginData,INSTANCE_DIR);
  try{lstatSync(root)}catch(error){if(error?.code==='ENOENT')return createInstance(root);fail('INSTANCE_DATA_UNAVAILABLE')}
  return validateInstance(root);
}
