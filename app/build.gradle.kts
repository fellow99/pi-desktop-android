plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
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
    // 运行时两库（Maven Central；bridge 提供 Kotlin API + JNI 引导件，runtime 提供引擎 .so）
    implementation(libs.node.bridge)
    runtimeOnly(libs.node.runtime)

    implementation(libs.kotlinx.coroutines.android)
}
