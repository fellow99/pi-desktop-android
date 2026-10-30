import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// ─────────────────────────────────────────────────────────────────────────────
// 签名材料不入库（宪法 C9 / 规划 §16.3）：
//   keystore.properties（已 gitignore；模板见 keystore.properties.sample）提供
//   storeFile/storePassword/keyAlias/keyPassword；文件缺失 ⇒ release 产出未签名包。
// ─────────────────────────────────────────────────────────────────────────────
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    // 包名/应用名定稿（docs/000-工程规划.md 头部表，2026-10-24）：org.fellow99.pi.PiDesktopAndroid / Pi Desktop
    namespace = "org.fellow99.pi.PiDesktopAndroid"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "org.fellow99.pi.PiDesktopAndroid"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 1
        versionName = "0.1.0"
        // 引擎矩阵：libnode.so 只出 arm64-v8a（runtime.lock.json#matrix，规划 §12）
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 签名材料本地持有、不入库（规划 §16.3）；首发为侧载/国内渠道签名 APK。
            if (keystoreProps.isNotEmpty()) {
                signingConfig = signingConfigs.create("release") {
                    storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                    storePassword = keystoreProps.getProperty("storePassword")
                    keyAlias = keystoreProps.getProperty("keyAlias")
                    keyPassword = keystoreProps.getProperty("keyPassword")
                }
            }
        }
        debug {
            // G11：诊断面（--inspect/后门）只在 debug 构建，release 关闭（ark R7 同纪律）
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        jniLibs {
            // 16 KB 对齐门禁（G5）：uncompressed + page-aligned 由 AGP 保序
            useLegacyPackaging = false
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    androidResources {
        // .tar.gz 已压缩：禁止 aapt 二次压缩，利于库以 fd 直读（规划 §7.1 🔶 bridge §5.5）
        noCompress += "gz"
    }
}

dependencies {
    // JNI 桥（Maven Central）：Kotlin API + libnode_bridge.so + libnode_host_client.so + 引导 JS。
    implementation(libs.node.bridge)

    // 引擎 libnode.so + libc++_shared.so：现由 Maven Central `node-runtime:24.22.1`（small-icu）
    // 以 runtimeOnly 直解进 APK（对齐 oc-desktop-android 001；verify-runtime.mjs 门禁 SHA-256 + ELF 六项，
    // 单一事实源 = 工程根 runtime.lock.json）。
    // 历史：早期用 scripts/provision-engine.mjs 从本机 aosp-node-runtime 目录投放 jniLibs（不入库）；
    // 本机无 24.22.1 的 Central AAR 缓存时该脚本仍作零网兜底（--check 验 sha=be1d16…）。
    // 为什么不能用旧版 node-runtime:24.2.0：该构建 --with-intl=none ⇒ Intl 全缺 ⇒
    // Next16 compiled 产物 Unicode 属性转义在编译期 SyntaxError（O2 实测），且翻译层模拟器引导 SEGV。
    runtimeOnly(libs.node.runtime)

    implementation(libs.kotlinx.coroutines.android)
}
