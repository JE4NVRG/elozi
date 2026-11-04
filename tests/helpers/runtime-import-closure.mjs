import { spawnSync } from 'node:child_process';

// Compile only: no source module is linked/evaluated, no provider is contacted.
// vm's native ESM parser avoids treating imports inside fixture strings/comments
// as executable imports. Dynamic imports still require the real image suite.
const CHECK = String.raw`
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, extname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const input=JSON.parse(readFileSync(0,'utf8'));
const root=resolve(input.root), visited=new Set(), edges=[], missing=[];
const relativePath=file=>relative(root,file).split(sep).join('/');
const supplied=path=>input.roots.some(base=>path===base||path.startsWith(base+'/'));
const queue=input.entries.map(path=>({file:resolve(root,path),from:'<entry>'}));
while(queue.length){
  const {file,from}=queue.shift(), path=relativePath(file);
  if(visited.has(path))continue;
  visited.add(path);
  if(path.startsWith('../')||!supplied(path)||!existsSync(file)){
    missing.push({from,path,reason:!supplied(path)?'not-in-image-or-mounts':'missing-source'});continue;
  }
  if(!['.js','.mjs','.cjs'].includes(extname(file)))continue;
  const mod=new vm.SourceTextModule(readFileSync(file,'utf8'),{identifier:path});
  for(const specifier of mod.dependencySpecifiers){
    if(!specifier.startsWith('.'))continue;
    const target=fileURLToPath(new URL(specifier,pathToFileURL(file)));
    edges.push({from:path,path:relativePath(target)});
    queue.push({file:target,from:path});
  }
}
process.stdout.write(JSON.stringify({modules:visited.size,edges:edges.length,missing}));
`;

export function runtimeImportClosure({root,entries,roots}) {
  const child=spawnSync(process.execPath,['--max-old-space-size=512','--v8-pool-size=2','--no-warnings','--experimental-vm-modules','--input-type=module','-e',CHECK],{
    input:JSON.stringify({root,entries,roots}),encoding:'utf8',windowsHide:true,
    timeout:30000,maxBuffer:2*1024*1024
  });
  if(child.error||child.status!==0||child.signal)throw new Error('Static ESM dependency compilation failed: '+(child.error?.code||child.signal||child.stderr?.slice(0,1000)||child.status));
  return JSON.parse(child.stdout);
}
