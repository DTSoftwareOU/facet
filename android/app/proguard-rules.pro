# Facet release shrinking rules.
# AndroidX, Compose, Room, WorkManager, OkHttp and kotlinx.serialization ship their own consumer rules.

# Keep line numbers for readable crash reports, without leaking source file names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# kotlinx.serialization: keep generated serializers of our @Serializable models.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers @kotlinx.serialization.Serializable class io.dtsoftware.facet.** {
    *** Companion;
    *** INSTANCE;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class io.dtsoftware.facet.**$$serializer { *; }

# Navigation type-safe routes are looked up by their serializable class.
-keep class io.dtsoftware.facet.ui.Routes** { *; }

# JLaTeXMath loads symbols, fonts and macro definitions by name at runtime.
-keep class ru.noties.jlatexmath.** { *; }
-keep class org.scilab.forge.jlatexmath.** { *; }
-dontwarn org.scilab.forge.jlatexmath.**
-dontwarn ru.noties.jlatexmath.**

# JetBrains Markdown parser: element types are referenced reflectively by name in some flavours.
-keep class org.intellij.markdown.** { *; }

# OkHttp optional platform integrations.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
