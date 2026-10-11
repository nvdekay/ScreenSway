// Real-window edge cases; requires an unlocked Windows desktop and ffprobe on PATH.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
if(process.platform!=='win32')throw Error('Run this test on Windows');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const helper=process.env.SCREENSWAY_TEST_HELPER??path.join(repo,'apps/desktop/src-tauri/binaries/screensway-capture-x86_64-pc-windows-msvc.exe');
const root=mkdtempSync(path.join(tmpdir(),'screensway-window-cases-'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const fixturePid=Number(execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Start-Process powershell.exe -ArgumentList @('-NoProfile','-File',${quote(path.join(repo,'scripts/windows-capture-fixture.ps1'))},'-RootPath',${quote(root)}) -WindowStyle Hidden -PassThru; $p.Id`],{encoding:'utf8',windowsHide:true}).trim());
let fixtureErrors='';let capture;
try{
for(let i=0;!existsSync(path.join(root,'fixture-ready.json'));i++){assert(i<100,fixtureErrors||'Fixture did not open');await wait(100);}
const {hwnd}=JSON.parse(readFileSync(path.join(root,'fixture-ready.json'),'utf8'));
// Show the capture fixture after Windows applies the hidden console startup flag.
execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class QaShow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }'; [QaShow]::ShowWindow([IntPtr]::new([long]${hwnd}),9) | Out-Null; [QaShow]::ShowWindow([IntPtr]::new([long]${hwnd}),5) | Out-Null`],{windowsHide:true});
await wait(600);
const sources=JSON.parse(execFileSync(helper,['--list-sources'],{encoding:'utf8'}));const source=sources.find(s=>s.id===hwnd);assert(source,'Test window is not available: '+JSON.stringify({hwnd,sources,fixtureErrors}));
const project=path.join(root,'Moved resized window.screensway');mkdirSync(project);const control=path.join(project,'.capture-control');writeFileSync(control,'recording');
capture=spawn(helper,['--output',project,'--control',control,'--source-kind','window','--source-id',hwnd,'--duration','30'],{windowsHide:true});let stdout='',stderr='';capture.stdout.on('data',c=>stdout+=c);capture.stderr.on('data',c=>stderr+=c);
for(let i=0;!stderr.includes('SCREENSWAY_READY');i++){assert(i<150&&capture.exitCode===null,stderr);await wait(100);}
await wait(800);
function command(data){writeFileSync(path.join(root,'fixture-command.json'),JSON.stringify(data));}
command({action:'click'});await wait(400);
command({action:'move',x:700,y:250});await wait(600);
command({action:'resize',width:700,height:430});await wait(600);
command({action:'minimize'});await wait(600);
command({action:'restore'});await wait(600);
command({action:'close'});
const exit=await Promise.race([new Promise(r=>capture.once('close',r)),wait(7000).then(()=>{throw Error('Capture did not automatically save after its window closed: '+stderr)})]);assert.equal(exit,0,stderr);
const result=JSON.parse(stdout);assert(result.durationMs>=2500&&result.durationMs<9000);
const click=result.pointerEvents.find(event=>event.type==='leftClick'||event.type==='rightClick');
assert(click&&click.x>0&&click.x<result.width&&click.y>0&&click.y<result.height,'A real click in the fixture must be captured inside the video');
const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',result.videoPath],{encoding:'utf8'}));assert(probe.streams.some(s=>s.codec_name==='h264'));assert(Math.abs(Number(probe.format.duration)*1000-result.durationMs)<100);
const invalid=spawn(helper,['--output',path.join(root,'Invalid.screensway'),'--source-kind','display','--source-id','nonexistent-display','--duration','0.5'],{windowsHide:true});let invalidError='';invalid.stderr.on('data',c=>invalidError+=c);const invalidExit=await new Promise(r=>invalid.once('close',r));assert.notEqual(invalidExit,0,'A disconnected display must not silently record the primary screen');
console.log(JSON.stringify({pass:true,cases:['physical-click','move','resize','minimize','restore','close-and-save','disconnected-display'],durationMs:result.durationMs,artifacts:root}));
}finally{capture?.kill();try{process.kill(fixturePid);}catch{}}
