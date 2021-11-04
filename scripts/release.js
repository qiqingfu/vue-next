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
/**
 * 是否为发布演练
 */
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
 * 在命令行交互时用于选择发布的版本选项
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

  /**
   * 当进行发布测试时，只输出脚本的 log
   */
const dryRun = (bin, args, opts = {}) =>
  console.log(chalk.blue(`[dryrun] ${bin} ${args.join(' ')}`), opts)


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

/**
 * release 主入口函数
 */
async function main() {
  /**
   * 如果第一个参数手动指定了要发布的版本号
   */
  let targetVersion = args._[0]

  /**
   * 如果未指定目标版本号，进行命令行交互，让用户选择
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
     * 如果选择自定义版本
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

  // 输入执行到每一步的 log 日志 
  step('\nRunning tests...')
  /**
   * skipTests：跳过测试
   * isDryRun：如果设置了 dry，则跳过测试
   */
  if (!skipTests && !isDryRun) {
    // 删除 jest 缓存目录，然后不运行测试直接退出
    await run(bin('jest'), ['--clearCache'])
    // 运行 npm test 命令
    await run('npm', ['test', '--', '--bail'])
  } else {
    console.log(`(skipped)`)
  }

  // 更新所有软件包的版本和相互依赖关系
  step('\nUpdating cross dependencies...')
  updateVersions(targetVersion)

  // 构建所有带类型的软件包
  step('\nBuilding all packages...')
  if (!skipBuild && !isDryRun) {
    // 运行 npm run build --release
    await run('npm', ['run', 'build', '--', '--release'])
    step('\nVerifying type declarations...')
    await run('npm', ['run', 'test-dts-only'])
  } else {
    console.log(`(skipped)`)
  }

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

  // 发布软件包
  step('\nPublishing packages...')
  for (const pkg of packages) {
    await publishPackage(pkg, targetVersion, runIfNotDry)
  }

  // 推送到 GitHub
  step('\nPushing to GitHub...')
  // 打 git tag 标签
  await runIfNotDry('git', ['tag', `v${targetVersion}`])
  // 
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
  // 1. 更新根 package.json
  updatePackage(path.resolve(__dirname, '..'), version)
  // 2. 更新所有的 packages
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

/**
 * 向 npm 注册软件包，并制定软件包的标签
 * @param {*} pkgName 
 * @param {*} version 
 * @param {*} runIfNotDry 
 */
async function publishPackage(pkgName, version, runIfNotDry) {
  if (skippedPackages.includes(pkgName)) {
    return
  }
  const pkgRoot = getPkgRoot(pkgName)
  const pkgPath = path.resolve(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  /**
   * 如果你在package.json中设置 "private": true，那么npm将拒绝发布它。
   */
  if (pkg.private) {
    return
  }

  // vue 包被发布在 next 标签下
  // yarn add vue@next 安装
  // 除 vue 之外的其他软件包都可以以 latest 标签发布
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

  step(`Publishing ${pkgName}...`)
  try {
    /**
     * 使用 yarn 发布 npm 包
     */
    await runIfNotDry(
      // note: use of yarn is intentional here as we rely on its publishing
      // behavior.
      // --new-version <version> 通过使用version的值来跳过新版本的提示
      'yarn',
      [
        'publish',
        '--new-version',
        version,
        /**
         * 发布带有特定标签的软件包，别人使用时可以安装：
         * yarn add vue@next
         * yarn add @vue/compiler-core@alpha
         */
        ...(releaseTag ? ['--tag', releaseTag] : []),
        /**
         * 控制是否将此包作为公共包发布
         */
        '--access',
        'public'
      ],
      {
        cwd: pkgRoot, // 子进程的当前工作目录 packages/**/
        stdio: 'pipe' // 子进程和父进程创建管道
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