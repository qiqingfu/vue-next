const args = require('minimist')(process.argv.slice(2))
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const semver = require('semver')
const currentVersion = require('../package.json').version
const { prompt } = require('enquirer')
const execa = require('execa')

/**
 * 如果运行 release 时传递 preid 参数，以传递的参数为主（预发布版本）
 * semver 1.2.3 -i prerelease --preid beta
 * 1.2.4-beta.0
 */
const preId =
  args.preid ||
  (semver.prerelease(currentVersion) && semver.prerelease(currentVersion)[0])
const isDryRun = args.dry
/**
 * 跳过运行测试
 */
const skipTests = args.skipTests
/**
 * 跳过构建
 */
const skipBuild = args.skipBuild
/**
 * 读取 packages 下的目录内容
 */
const packages = fs
  .readdirSync(path.resolve(__dirname, '../packages'))
  .filter(p => !p.endsWith('.ts') && !p.startsWith('.'))

const skippedPackages = []

/**
 * 如果是预发布版本，versionIncrements 中多加入 prepatch、preminor、premajor 和 prerelease
 * 在命令行交互时用于选择的项
 * 
 * 发布类型
 */
const versionIncrements = [
  'patch',
  'minor',
  'major',
  ...(preId ? ['prepatch', 'preminor', 'premajor', 'prerelease'] : [])
]

/**
 * 返回由发布类型（major，premajor，minor，preminor，patch，prepatch，prerelease）递增的版本，
 * 如果无效则为空
 * @param {string} i 
 */
const inc = i => semver.inc(currentVersion, i, preId)

/**
 * 获取指定 bin 目录下的脚本路径 
 */
const bin = name => path.resolve(__dirname, '../node_modules/.bin/' + name)

/**
 * 通过 script 运行指定 .bin/ 目录下的脚本
 * 在本地项目安装第三方包时，若设置了 bin 字段对应的脚本，会创建一个对应的链接到 node_modules/.bin/xxx
 * https://docs.npmjs.com/cli/v7/configuring-npm/package-json#bin
 */
const run = (bin, args, opts = {}) =>
/**
 * 运行一个可执行文件。可以认为这是child_process.execFile()和child_process.spoon()的混合。
 * http://nodejs.cn/api/child_process.html#child_process_child_process_execfile_file_args_options_callback
 */
  execa(bin, args, { stdio: 'inherit', ...opts })

const dryRun = (bin, args, opts = {}) =>
  console.log(chalk.blue(`[dryrun] ${bin} ${args.join(' ')}`), opts)

  /**
   * isDryRun ??
   */
const runIfNotDry = isDryRun ? dryRun : run

/**
 * 获取 packages 下指定的包路径
 * @param {*} pkg 
 */
const getPkgRoot = pkg => path.resolve(__dirname, '../packages/' + pkg)

/**
 * 每一步的 msg 打印
 * @param {string} msg 
 */
const step = msg => console.log(chalk.cyan(msg))

async function main() {
  /**
   * 如果第一个参数手动指定了要发布的版本号
   */
  let targetVersion = args._[0]

  /**
   * 如果未指定目标版本号，则询问用户
   */
  if (!targetVersion) {
    // no explicit version, offer suggestions
    const { release } = await prompt({
      type: 'select',
      name: 'release', // 用于接收用户输入的键值
      message: 'Select release type',
      choices: versionIncrements.map(i => `${i} (${inc(i)})`).concat(['custom'])
    })

    /**
     * 自定义版本
     * type：input，接收用户输入并返回一个字符串
     */
    if (release === 'custom') {
      targetVersion = (
        await prompt({
          type: 'input',
          name: 'version',
          message: 'Input custom version',
          initial: currentVersion
        })
      ).version
    } else {
      /**
       * const release = 'major (3.2.20)'
       * release.match(/\((.*))\/)[1]  // 3.2.20
       * 
       */
      targetVersion = release.match(/\((.*)\)/)[1]
    }
  }

  /**
   * 返回解析后的版本，无效则返回 null
   */
  if (!semver.valid(targetVersion)) {
    throw new Error(`invalid target version: ${targetVersion}`)
  }

  /**
   * 让用户确认是否应用 targetVersion 版本号?
   */
  const { yes } = await prompt({
    type: 'confirm',
    name: 'yes',
    message: `Releasing v${targetVersion}. Confirm?`
  })

  /**
   * 选择 No，则直接中断后续的逻辑
   */
  if (!yes) {
    return
  }

  // run tests before release
  step('\nRunning tests...')
  /**
   * skipTests：跳过测试
   * isDryRun：???
   */
  if (!skipTests && !isDryRun) {
    // 删除 jest 缓存目录，然后不运行测试直接退出
    await run(bin('jest'), ['--clearCache'])
    // 运行 npm test 命令??
    await run('npm', ['test', '--', '--bail'])
  } else {
    console.log(`(skipped)`)
  }

  // update all package versions and inter-dependencies
  step('\nUpdating cross dependencies...')
  updateVersions(targetVersion)

  // build all packages with types
  step('\nBuilding all packages...')
  if (!skipBuild && !isDryRun) {
    // 运行 npm run build --release
    await run('npm', ['run', 'build', '--', '--release'])
    // test generated dts files
    step('\nVerifying type declarations...')
    await run('npm', ['run', 'test-dts-only'])
  } else {
    console.log(`(skipped)`)
  }

  // generate changelog
  // 生成更新日志
  await run(`npm`, ['run', 'changelog'])

  /**
   * 提交 commit
   */
  const { stdout } = await run('git', ['diff'], { stdio: 'pipe' })
  if (stdout) {
    step('\nCommitting changes...')
    await runIfNotDry('git', ['add', '-A'])
    await runIfNotDry('git', ['commit', '-m', `release: v${targetVersion}`])
  } else {
    console.log('No changes to commit.')
  }

  // publish packages
  step('\nPublishing packages...')
  for (const pkg of packages) {
    await publishPackage(pkg, targetVersion, runIfNotDry)
  }

  // push to GitHub
  step('\nPushing to GitHub...')
  await runIfNotDry('git', ['tag', `v${targetVersion}`])
  await runIfNotDry('git', ['push', 'origin', `refs/tags/v${targetVersion}`])
  await runIfNotDry('git', ['push'])

  if (isDryRun) {
    console.log(`\nDry run finished - run git diff to see package changes.`)
  }

  if (skippedPackages.length) {
    console.log(
      chalk.yellow(
        `The following packages are skipped and NOT published:\n- ${skippedPackages.join(
          '\n- '
        )}`
      )
    )
  }
  console.log()
}

/**
 * 更新到目标版本
 * @param {string} version 
 */
function updateVersions(version) {
  // 1. update root package.json
  updatePackage(path.resolve(__dirname, '..'), version)
  // 2. update all packages
  packages.forEach(p => updatePackage(getPkgRoot(p), version))
}

/**
 * 更新版本号
 * @param {*} pkgRoot 
 * @param {*} version 
 */
function updatePackage(pkgRoot, version) {
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  /**
   * 读取指定目录下 package.json 文件内容
   */
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  pkg.version = version
  /**
   * 更新当前包依赖
   */
  updateDeps(pkg, 'dependencies', version)
  updateDeps(pkg, 'peerDependencies', version)
  /**
   * 将更新后的 package.json 重新写入
   */
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * 对当前包依赖的指定包进行更新
 */
function updateDeps(pkg, depType, version) {
  const deps = pkg[depType]
  if (!deps) return
  /**
   * 遍历 dependencies 或 peerDependencies 对象的 key
   */
  Object.keys(deps).forEach(dep => {
    /**
     * 如果更新的依赖 dep 为 vue 或依赖的是 packages 目录下的子包，则更新
     */
    if (
      dep === 'vue' ||
      (dep.startsWith('@vue') && packages.includes(dep.replace(/^@vue\//, '')))
    ) {
      console.log(
        chalk.yellow(`${pkg.name} -> ${depType} -> ${dep}@${version}`)
      )
      deps[dep] = version
    }
  })
}

async function publishPackage(pkgName, version, runIfNotDry) {
  if (skippedPackages.includes(pkgName)) {
    return
  }
  const pkgRoot = getPkgRoot(pkgName)
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  if (pkg.private) {
    return
  }

  // For now, all 3.x packages except "vue" can be published as
  // `latest`, whereas "vue" will be published under the "next" tag.
  let releaseTag = null
  if (args.tag) {
    releaseTag = args.tag
  } else if (version.includes('alpha')) {
    releaseTag = 'alpha'
  } else if (version.includes('beta')) {
    releaseTag = 'beta'
  } else if (version.includes('rc')) {
    releaseTag = 'rc'
  } else if (pkgName === 'vue') {
    // TODO remove when 3.x becomes default
    releaseTag = 'next'
  }

  // TODO use inferred release channel after official 3.0 release
  // const releaseTag = semver.prerelease(version)[0] || null

  step(`Publishing ${pkgName}...`)
  try {
    await runIfNotDry(
      // note: use of yarn is intentional here as we rely on its publishing
      // behavior.
      'yarn',
      [
        'publish',
        '--new-version',
        version,
        ...(releaseTag ? ['--tag', releaseTag] : []),
        '--access',
        'public'
      ],
      {
        cwd: pkgRoot,
        stdio: 'pipe'
      }
    )
    console.log(chalk.green(`Successfully published ${pkgName}@${version}`))
  } catch (e) {
    if (e.stderr.match(/previously published/)) {
      console.log(chalk.red(`Skipping already published: ${pkgName}`))
    } else {
      throw e
    }
  }
}

main().catch(err => {
  console.error(err)
})
