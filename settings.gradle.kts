// pi-desktop-android —— Gradle 多模块工程
//
// 仓库顺序说明：本机对 dl.google.com / repo.maven.org 的直连不稳定，
// 故阿里云镜像前置（镜像 404 时自动回退官方仓库，对 CI 无害）。
// 与 aosp-node-bridge 的 settings.gradle.kts 同口径（那里的注释有实测记录）。

pluginManagement {
    repositories {
        // 实测（2026-10-27）：阿里云 public 镜像对 io.github.fellow99:node-runtime:24.2.0 滞后 404，
        // 故官方仓前置、镜像兜底（镜像在本机部分时段比官方直连稳定）。
        google()
        mavenCentral()
        gradlePluginPortal()
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // 注意：刻意**不**放 mavenLocal —— 本机 mavenLocal 里有
        // io.github.fellow99:node-runtime:24.22.1（small-icu 试验变体），
        // 放进来会让引擎版本依赖本机状态（宪法 A3：结论以锁定版本为准）。
        google()
        mavenCentral()
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
    }
}

rootProject.name = "pi-desktop-android"

include(":app")
