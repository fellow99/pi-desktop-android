// 根构建脚本：插件版本统一在 gradle/libs.versions.toml 声明，这里只 apply false。
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
}
