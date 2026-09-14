const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');
const { generateFiles } = require('./electronTemplate');
const { dispatchEvent } = require('./webhookDispatch');

const dataDir = process.env.DATA_DIR || __dirname;
const WORKSPACE_ROOT = path.join(dataDir, 'build-workspace');
const ARTIFACTS_ROOT = path.join(dataDir, 'artifacts');
fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });

// One real build at a time -- this sandbox/host has finite CPU, and running
// electron-builder concurrently would fight over the same wine prefix and
// electron-builder cache. This IS the "priority queue" for Pro/Dev: they
// jump ahead of Free-tier source-only requests (which don't need this
// queue at all -- those are instant, no compiling involved).
const queue = [];
let processing = false;

function enqueue(job){
  queue.push(job);
  processNext();
}
async function processNext(){
  if(processing || queue.length===0) return;
  processing = true;
  const job = queue.shift();
  try{ await runBuild(job); }
  catch(e){ db.failBuild(job.buildId, 'Internal build worker error: '+e.message); }
  finally{
    processing = false;
    processNext();
  }
}

function run(cmd, args, cwd, onLog, trackChild){
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    if(trackChild) trackChild(child);
    let lastErr = '';
    child.stdout.on('data', d => onLog(d.toString()));
    child.stderr.on('data', d => { lastErr = d.toString(); onLog(d.toString()); });
    child.on('error', reject);
    child.on('close', code => {
      if(code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}${lastErr ? ': '+lastErr.slice(-500) : ''}`));
    });
  });
}

const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // real compiles genuinely take minutes

async function runBuild(job){
  const { buildId, userId, project, servers, kind } = job;
  const workDir = path.join(WORKSPACE_ROOT, buildId);
  fs.mkdirSync(workDir, { recursive: true });

  let stderrTail = ''; // kept only for inclusion in a failure message, never shown as fake progress
  let currentChild = null;

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    db.failBuild(buildId, `Build timed out after ${BUILD_TIMEOUT_MS/1000}s.`);
    // Actually kill the real OS process -- otherwise the awaited run() below
    // never settles, this function never reaches its finally{}, and the
    // single-build queue would be stuck forever behind a zombie process.
    if(currentChild && !currentChild.killed) currentChild.kill('SIGKILL');
  }, BUILD_TIMEOUT_MS);

  try{
    db.updateBuild(buildId, { status:'starting', started_at: Date.now(), progress: 5 });
    db.appendBuildLog(buildId, 'Build starting.');
    dispatchEvent(userId, 'build.started', { buildId, kind });

    const { files } = generateFiles(project, servers);
    for(const [rel, content] of Object.entries(files)){
      const filePath = path.join(workDir, rel);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    db.appendBuildLog(buildId, 'Project files written.');
    if(timedOut) return;

    db.updateBuild(buildId, { status:'building', progress: 15 });
    db.appendBuildLog(buildId, 'Running npm install (real child process)...');
    await run('npm', ['install', '--no-audit', '--no-fund'], workDir, (chunk) => { stderrTail = chunk; }, (c) => currentChild = c);
    db.appendBuildLog(buildId, 'Dependencies installed.');
    if(timedOut) return;

    db.updateBuild(buildId, { progress: 50 });
    const target = kind === 'production_exe' ? ['--win', '--x64'] : ['--linux', 'AppImage'];
    db.appendBuildLog(buildId, 'Running electron-builder ' + target.join(' ') + ' (real cross-compile)...');
    await run('npx', ['electron-builder', ...target], workDir, (chunk) => { stderrTail = chunk; }, (c) => currentChild = c);
    if(timedOut) return;

    db.updateBuild(buildId, { progress: 90 });
    const distDir = path.join(workDir, 'dist');
    const candidates = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];
    const artifactName = candidates.find(f => kind === 'production_exe' ? f.endsWith('.exe') : f.endsWith('.AppImage'));
    if(!artifactName){
      throw new Error('Build finished but no ' + (kind==='production_exe'?'.exe':'.AppImage') + ' was found in dist/ -- refusing to mark completed.');
    }
    const builtPath = path.join(distDir, artifactName);
    const stat = fs.statSync(builtPath);
    if(!stat.isFile() || stat.size === 0){
      throw new Error('Build output exists but is empty -- refusing to mark completed.');
    }

    // Move the real artifact to permanent storage, outside the disposable workspace.
    const finalName = buildId + '-' + artifactName;
    const finalPath = path.join(ARTIFACTS_ROOT, finalName);
    fs.copyFileSync(builtPath, finalPath);
    const finalStat = fs.statSync(finalPath);

    clearTimeout(timeoutHandle);
    if(timedOut) return;
    db.appendBuildLog(buildId, 'Real artifact verified on disk: '+finalName+' ('+finalStat.size+' bytes).');
    db.completeBuildWithArtifact(buildId, finalPath, finalStat.size);
    dispatchEvent(userId, 'build.completed', { buildId, kind, artifactSize: finalStat.size });
  }catch(e){
    clearTimeout(timeoutHandle);
    if(!timedOut){
      const detail = stderrTail ? (e.message + ' | last output: ' + stderrTail.slice(-300)) : e.message;
      db.appendBuildLog(buildId, 'Build failed: '+detail);
      db.failBuild(buildId, detail);
      dispatchEvent(userId, 'build.failed', { buildId, kind, error: detail });
    }
  }finally{
    // Clean up the disposable build workspace (node_modules etc.) regardless
    // of outcome -- the real artifact was already copied out above.
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { enqueue };
