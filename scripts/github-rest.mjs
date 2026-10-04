import { execFileSync } from "node:child_process";

// Read-only GitHub REST access without gh. curl honours the environment's
// proxy and CA settings; DOCKLET_GITHUB_TOKEN authenticates where a token is
// required, a public repository needs none.
export function curlArguments(repo,path,{raw=false,env=process.env}={}) {
  if(!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || !/^[A-Za-z0-9/._?=&-]+$/.test(path) || path.split(/[/?]/).includes(".."))throw new Error("Unsupported GitHub REST path");
  const args=["-fsSL","--proto","=https","-H","Accept: "+(raw?"application/vnd.github.raw":"application/vnd.github+json"),"-H","X-GitHub-Api-Version: 2022-11-28"];
  if(env.DOCKLET_GITHUB_TOKEN)args.push("-H","Authorization: Bearer "+env.DOCKLET_GITHUB_TOKEN);
  args.push("https://api.github.com/repos/"+repo+"/"+path);
  return args;
}

export function githubGet(repo,path,{raw=false,env=process.env,run=execFileSync}={}) {
  const text=run("curl",curlArguments(repo,path,{raw,env}),{encoding:"utf8",maxBuffer:32*1024*1024});
  return raw?text:JSON.parse(text);
}
