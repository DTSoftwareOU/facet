package io.dtsoftware.facet.ui

import android.net.Uri
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.ui.auth.AuthScreen
import io.dtsoftware.facet.ui.auth.ForgotPasswordScreen
import io.dtsoftware.facet.ui.auth.RecoveryCodeScreen
import io.dtsoftware.facet.ui.home.ArchiveScreen
import io.dtsoftware.facet.ui.home.HomeScreen
import io.dtsoftware.facet.ui.home.SearchScreen
import io.dtsoftware.facet.ui.lock.AppLockGate
import io.dtsoftware.facet.ui.onboarding.OnboardingScreen
import io.dtsoftware.facet.ui.settings.AboutScreen
import io.dtsoftware.facet.ui.settings.AccountScreen
import io.dtsoftware.facet.ui.settings.AppearanceScreen
import io.dtsoftware.facet.ui.settings.AssistantEditScreen
import io.dtsoftware.facet.ui.settings.AssistantsScreen
import io.dtsoftware.facet.ui.settings.ChatPrefsScreen
import io.dtsoftware.facet.ui.settings.DataScreen
import io.dtsoftware.facet.ui.settings.DevicesScreen
import io.dtsoftware.facet.ui.settings.PrivacyScreen
import io.dtsoftware.facet.ui.settings.PromptsScreen
import io.dtsoftware.facet.ui.settings.ProviderEditScreen
import io.dtsoftware.facet.ui.settings.ProvidersScreen
import io.dtsoftware.facet.ui.settings.SettingsScreen
import io.dtsoftware.facet.ui.theme.FacetMotion
import io.dtsoftware.facet.ui.theme.FacetTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.Serializable

sealed interface LaunchRequest {
    data class OpenConversation(val id: String) : LaunchRequest
    data class NewChat(val voice: Boolean) : LaunchRequest
    data class Share(val text: String?, val uris: List<Uri>) : LaunchRequest
    /** Browser redirect after an MCP server sign-in. */
    data class McpOAuth(val state: String?, val code: String?, val error: String?) : LaunchRequest
}

object Routes {
    @Serializable object Onboarding
    @Serializable object Home
    @Serializable object Search
    @Serializable object Archive
    @Serializable object Settings
    @Serializable object Appearance
    @Serializable object ChatPrefs
    @Serializable object Providers
    @Serializable data class ProviderEdit(val providerId: String? = null, val kind: String? = null)
    @Serializable object Assistants
    @Serializable data class AssistantEdit(val assistantId: String? = null)
    @Serializable object Prompts
    @Serializable object WebSearch
    @Serializable object MediaModels
    @Serializable object McpServers
    @Serializable data class McpServerEdit(val serverId: String? = null)
    @Serializable object Skills
    @Serializable data class SkillEdit(val skillId: String? = null)
    @Serializable object YourPc
    @Serializable object Account
    @Serializable object Devices
    @Serializable object Privacy
    @Serializable object Data
    @Serializable object About
    @Serializable data class Auth(val signUp: Boolean = false, val fromOnboarding: Boolean = false)
    @Serializable object Forgot
    @Serializable data class RecoveryCode(val reason: String)
}

/** Holds a freshly generated recovery code between screens without putting it in saved state. */
class RecoveryCodeHolder { var code: String? = null }

@Composable
fun FacetRoot(container: AppContainer, launchRequests: MutableStateFlow<LaunchRequest?>) {
    val prefs by container.settings.local.collectAsStateWithLifecycle()
    val nav = rememberNavController()
    val codeHolder = remember { RecoveryCodeHolder() }
    val start: Any = if (prefs.onboardingDone) Routes.Home else Routes.Onboarding
    val reduced = FacetTheme.reducedMotion
    val dur = if (reduced) 150 else 320

    // MCP sign-in redirects are handled here, before the chat screen sees launch requests.
    val pendingRequest by launchRequests.collectAsStateWithLifecycle()
    androidx.compose.runtime.LaunchedEffect(pendingRequest) {
        val r = pendingRequest as? LaunchRequest.McpOAuth ?: return@LaunchedEffect
        launchRequests.value = null
        if (r.code != null && r.state != null) {
            val serverId = runCatching { container.mcp.completeSignIn(r.state, r.code) }.getOrNull()
            if (serverId != null) nav.navigate(Routes.McpServerEdit(serverId)) { launchSingleTop = true }
        }
    }

    AppLockGate(enabled = prefs.appLock) {
        io.dtsoftware.facet.ui.update.UpdateHost(container.updates)
        Box(Modifier.fillMaxSize().background(FacetTheme.colors.background)) {
            NavHost(
                navController = nav,
                startDestination = start,
                enterTransition = {
                    if (reduced) fadeIn(tween(dur)) else
                        slideIntoContainer(AnimatedContentTransitionScope.SlideDirection.Start, tween(dur, easing = FacetMotion.Emphasized)) { it / 6 } +
                            fadeIn(tween(dur))
                },
                exitTransition = {
                    if (reduced) fadeOut(tween(dur)) else
                        slideOutOfContainer(AnimatedContentTransitionScope.SlideDirection.Start, tween(dur, easing = FacetMotion.Emphasized)) { it / 10 } +
                            fadeOut(tween(dur / 2))
                },
                popEnterTransition = {
                    if (reduced) fadeIn(tween(dur)) else
                        slideIntoContainer(AnimatedContentTransitionScope.SlideDirection.End, tween(dur, easing = FacetMotion.Emphasized)) { it / 10 } +
                            fadeIn(tween(dur))
                },
                popExitTransition = {
                    if (reduced) fadeOut(tween(dur)) else
                        slideOutOfContainer(AnimatedContentTransitionScope.SlideDirection.End, tween(dur, easing = FacetMotion.Emphasized)) { it / 6 } +
                            fadeOut(tween(dur / 2))
                },
            ) {
                composable<Routes.Onboarding> {
                    OnboardingScreen(
                        container = container,
                        onCreateAccount = { nav.navigate(Routes.Auth(signUp = true, fromOnboarding = true)) },
                        onSignIn = { nav.navigate(Routes.Auth(signUp = false, fromOnboarding = true)) },
                        onAddProvider = { kind -> nav.navigate(Routes.ProviderEdit(kind = kind)) },
                        onFinish = { finishOnboarding(container, nav) },
                    )
                }
                composable<Routes.Home> {
                    HomeScreen(
                        container = container,
                        launchRequests = launchRequests,
                        onSearch = { nav.navigate(Routes.Search) },
                        onSettings = { nav.navigate(Routes.Settings) },
                        onAccount = { nav.navigate(Routes.Account) },
                        onArchive = { nav.navigate(Routes.Archive) },
                        onProviders = { nav.navigate(Routes.Providers) },
                    )
                }
                composable<Routes.Search> {
                    SearchScreen(container, onBack = { nav.popBackStack() }) { id ->
                        launchRequests.value = LaunchRequest.OpenConversation(id)
                        nav.popBackStack(Routes.Home, inclusive = false)
                    }
                }
                composable<Routes.Archive> {
                    ArchiveScreen(container, onBack = { nav.popBackStack() }) { id ->
                        launchRequests.value = LaunchRequest.OpenConversation(id)
                        nav.popBackStack(Routes.Home, inclusive = false)
                    }
                }
                composable<Routes.Settings> {
                    SettingsScreen(container, onBack = { nav.popBackStack() }, navigate = { nav.navigate(it) })
                }
                composable<Routes.Appearance> { AppearanceScreen(container) { nav.popBackStack() } }
                composable<Routes.ChatPrefs> { ChatPrefsScreen(container) { nav.popBackStack() } }
                composable<Routes.Providers> {
                    ProvidersScreen(
                        container,
                        onBack = { nav.popBackStack() },
                        onEdit = { id -> nav.navigate(Routes.ProviderEdit(providerId = id)) },
                        onAdd = { kind -> nav.navigate(Routes.ProviderEdit(kind = kind)) },
                    )
                }
                composable<Routes.ProviderEdit> { entry ->
                    val r = entry.toRoute<Routes.ProviderEdit>()
                    ProviderEditScreen(container, r.providerId, r.kind) { nav.popBackStack() }
                }
                composable<Routes.Assistants> {
                    AssistantsScreen(container, onBack = { nav.popBackStack() }) { id -> nav.navigate(Routes.AssistantEdit(id)) }
                }
                composable<Routes.AssistantEdit> { entry ->
                    AssistantEditScreen(container, entry.toRoute<Routes.AssistantEdit>().assistantId) { nav.popBackStack() }
                }
                composable<Routes.Prompts> { PromptsScreen(container) { nav.popBackStack() } }
                composable<Routes.WebSearch> { io.dtsoftware.facet.ui.settings.WebSearchScreen(container) { nav.popBackStack() } }
                composable<Routes.MediaModels> {
                    io.dtsoftware.facet.ui.settings.MediaModelsScreen(container, onBack = { nav.popBackStack() }, onProviders = { nav.navigate(Routes.Providers) })
                }
                composable<Routes.McpServers> {
                    io.dtsoftware.facet.ui.settings.McpServersScreen(container, onBack = { nav.popBackStack() }) { id -> nav.navigate(Routes.McpServerEdit(id)) }
                }
                composable<Routes.McpServerEdit> { entry ->
                    io.dtsoftware.facet.ui.settings.McpServerEditScreen(container, entry.toRoute<Routes.McpServerEdit>().serverId) { nav.popBackStack() }
                }
                composable<Routes.Skills> {
                    io.dtsoftware.facet.ui.settings.SkillsScreen(container, onBack = { nav.popBackStack() }) { id -> nav.navigate(Routes.SkillEdit(id)) }
                }
                composable<Routes.SkillEdit> { entry ->
                    io.dtsoftware.facet.ui.settings.SkillEditScreen(container, entry.toRoute<Routes.SkillEdit>().skillId) { nav.popBackStack() }
                }
                composable<Routes.YourPc> { io.dtsoftware.facet.ui.settings.PcSettingsScreen(container) { nav.popBackStack() } }
                composable<Routes.Account> {
                    AccountScreen(
                        container,
                        onBack = { nav.popBackStack() },
                        onSignIn = { nav.navigate(Routes.Auth(signUp = false)) },
                        onCreate = { nav.navigate(Routes.Auth(signUp = true)) },
                        onDevices = { nav.navigate(Routes.Devices) },
                        onRecoveryCode = { code -> codeHolder.code = code; nav.navigate(Routes.RecoveryCode("regenerated")) },
                    )
                }
                composable<Routes.Devices> { DevicesScreen(container) { nav.popBackStack() } }
                composable<Routes.Privacy> { PrivacyScreen(container) { nav.popBackStack() } }
                composable<Routes.Data> { DataScreen(container) { nav.popBackStack() } }
                composable<Routes.About> { AboutScreen(container) { nav.popBackStack() } }
                composable<Routes.Auth> { entry ->
                    val r = entry.toRoute<Routes.Auth>()
                    AuthScreen(
                        container = container,
                        signUpInitially = r.signUp,
                        onBack = { nav.popBackStack() },
                        onForgot = { nav.navigate(Routes.Forgot) },
                        onSignedUp = { code ->
                            codeHolder.code = code
                            nav.navigate(Routes.RecoveryCode(if (r.fromOnboarding) "signup-onboarding" else "signup")) {
                                popUpTo<Routes.Auth> { inclusive = true }
                            }
                        },
                        onSignedIn = {
                            if (r.fromOnboarding) finishOnboarding(container, nav) else nav.popBackStack()
                        },
                    )
                }
                composable<Routes.Forgot> {
                    ForgotPasswordScreen(container, onBack = { nav.popBackStack() }) { code ->
                        codeHolder.code = code
                        nav.navigate(Routes.RecoveryCode("reset")) { popUpTo<Routes.Forgot> { inclusive = true } }
                    }
                }
                composable<Routes.RecoveryCode> { entry ->
                    val reason = entry.toRoute<Routes.RecoveryCode>().reason
                    RecoveryCodeScreen(code = codeHolder.code.orEmpty(), reason = reason) {
                        codeHolder.code = null
                        if (reason == "signup-onboarding" || !container.settings.local.value.onboardingDone) {
                            finishOnboarding(container, nav)
                        } else {
                            nav.popBackStack()
                        }
                    }
                }
            }
        }
    }
}

private fun finishOnboarding(container: AppContainer, nav: NavHostController) {
    container.settings.updateLocal { it.copy(onboardingDone = true) }
    nav.navigate(Routes.Home) {
        popUpTo(0) { inclusive = true }
        launchSingleTop = true
    }
}
