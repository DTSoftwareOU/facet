package io.dtsoftware.facet.ui.onboarding

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.dtsoftware.facet.AppContainer
import io.dtsoftware.facet.R
import io.dtsoftware.facet.llm.ProviderKind
import io.dtsoftware.facet.sync.AccountState
import io.dtsoftware.facet.ui.components.AssemblingGem
import io.dtsoftware.facet.ui.components.ButtonStyle
import io.dtsoftware.facet.ui.components.FacetButton
import io.dtsoftware.facet.ui.components.FacetIcon
import io.dtsoftware.facet.ui.components.Gem
import io.dtsoftware.facet.ui.components.ProviderBadge
import io.dtsoftware.facet.ui.settings.ProviderOrder
import io.dtsoftware.facet.ui.theme.FacetMotion
import io.dtsoftware.facet.ui.theme.FacetShapes
import io.dtsoftware.facet.ui.theme.FacetTheme

@Composable
fun OnboardingScreen(
    container: AppContainer,
    onCreateAccount: () -> Unit,
    onSignIn: () -> Unit,
    onAddProvider: (String) -> Unit,
    onFinish: () -> Unit,
) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    val account by container.auth.state.collectAsStateWithLifecycle()
    val providers by container.providers.observeAll().collectAsStateWithLifecycle(emptyList())
    BackHandler(step > 0) { step-- }
    // Steps move forward in reading direction: from the right in left-to-right languages, from the left in RTL.
    val forward = if (LocalLayoutDirection.current == LayoutDirection.Rtl) -1 else 1

    Box(Modifier.fillMaxSize().background(FacetTheme.colors.background).statusBarsPadding().navigationBarsPadding()) {
        AnimatedContent(
            targetState = step,
            transitionSpec = {
                val dir = if (targetState > initialState) forward else -forward
                (slideInHorizontally(tween(380, easing = FacetMotion.Emphasized)) { it / 5 * dir } + fadeIn(tween(300))) togetherWith
                    (slideOutHorizontally(tween(380, easing = FacetMotion.Emphasized)) { -it / 8 * dir } + fadeOut(tween(200)))
            },
            label = "onboarding",
        ) { s ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(
                    Modifier
                        .widthIn(max = 480.dp)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 28.dp, vertical = 24.dp),
                ) {
                    when (s) {
                        0 -> Welcome { step = 1 }
                        1 -> AccountStep(
                            signedIn = account is AccountState.SignedIn,
                            onCreate = onCreateAccount,
                            onSignIn = onSignIn,
                            onSkip = { step = 2 },
                        )
                        else -> KeysStep(
                            connected = providers.map { ProviderKind.fromId(it.kind) }.toSet(),
                            onAdd = onAddProvider,
                            onFinish = onFinish,
                        )
                    }
                }
            }
        }
        StepDots(step, Modifier.align(Alignment.TopCenter).padding(top = 18.dp))
    }
}

@Composable
private fun StepDots(step: Int, modifier: Modifier) {
    val c = FacetTheme.colors
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(3) { i ->
            Box(Modifier.size(width = if (i == step) 18.dp else 6.dp, height = 6.dp).clip(CircleShape).background(if (i == step) c.text else c.outline))
        }
    }
}

@Composable
private fun Welcome(onNext: () -> Unit) {
    val c = FacetTheme.colors
    Column(horizontalAlignment = Alignment.Start) {
        AssemblingGem(size = 92.dp)
        Spacer(Modifier.height(36.dp))
        Text(stringResource(R.string.onboarding_welcome_title), style = FacetTheme.type.display, color = c.text)
        Spacer(Modifier.height(14.dp))
        Text(
            stringResource(R.string.onboarding_welcome_body),
            style = FacetTheme.type.body.copy(fontSize = FacetTheme.type.chat.fontSize, lineHeight = FacetTheme.type.chat.lineHeight),
            color = c.textSecondary,
        )
        Spacer(Modifier.height(28.dp))
        Point(R.drawable.ic_key, stringResource(R.string.onboarding_keys_point_title), stringResource(R.string.onboarding_keys_point_body))
        Point(R.drawable.ic_shield, stringResource(R.string.onboarding_encrypted_point_title), stringResource(R.string.onboarding_encrypted_point_body))
        Point(R.drawable.ic_brain, stringResource(R.string.onboarding_control_point_title), stringResource(R.string.onboarding_control_point_body))
        Spacer(Modifier.height(32.dp))
        FacetButton(stringResource(R.string.onboarding_get_started), onNext, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun Point(icon: Int, title: String, body: String) {
    val c = FacetTheme.colors
    Row(Modifier.padding(vertical = 9.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(36.dp).clip(FacetShapes.chip).background(c.surfaceHigh), contentAlignment = Alignment.Center) {
            FacetIcon(icon, null, tint = c.primary, size = 18.dp)
        }
        Spacer(Modifier.width(14.dp))
        Column {
            Text(title, style = FacetTheme.type.labelL, color = c.text)
            Text(body, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = c.textSecondary)
        }
    }
}

@Composable
private fun AccountStep(signedIn: Boolean, onCreate: () -> Unit, onSignIn: () -> Unit, onSkip: () -> Unit) {
    val c = FacetTheme.colors
    Column {
        Gem(size = 40.dp)
        Spacer(Modifier.height(24.dp))
        Text(stringResource(R.string.onboarding_sync_title), style = FacetTheme.type.display, color = c.text)
        Spacer(Modifier.height(12.dp))
        Text(
            stringResource(R.string.onboarding_sync_body),
            style = FacetTheme.type.body, color = c.textSecondary,
        )
        Spacer(Modifier.height(28.dp))
        if (signedIn) {
            FacetButton(stringResource(R.string.action_continue), onSkip, modifier = Modifier.fillMaxWidth())
        } else {
            FacetButton(stringResource(R.string.onboarding_create_account), onCreate, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            FacetButton(stringResource(R.string.onboarding_have_account), onSignIn, style = ButtonStyle.Tonal, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(10.dp))
            FacetButton(stringResource(R.string.onboarding_skip_account), onSkip, style = ButtonStyle.Text, modifier = Modifier.fillMaxWidth())
            Text(
                stringResource(R.string.onboarding_skip_account_note),
                style = FacetTheme.type.labelS.copy(fontWeight = FontWeight.Normal), color = c.textTertiary,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

@Composable
private fun KeysStep(connected: Set<ProviderKind>, onAdd: (String) -> Unit, onFinish: () -> Unit) {
    val c = FacetTheme.colors
    var showAll by rememberSaveable { mutableStateOf(false) }
    Column {
        Text(stringResource(R.string.onboarding_keys_title), style = FacetTheme.type.display, color = c.text)
        Spacer(Modifier.height(12.dp))
        Text(
            stringResource(R.string.onboarding_keys_body),
            style = FacetTheme.type.body, color = c.textSecondary,
        )
        Spacer(Modifier.height(22.dp))
        val list = if (showAll) ProviderOrder else ProviderOrder.take(4)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            list.forEach { kind ->
                val done = kind in connected
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(FacetShapes.group)
                        .background(if (done) c.primaryContainer else c.surface)
                        .border(1.dp, if (done) c.primaryContainer else c.outlineVariant, FacetShapes.group)
                        .clickable { onAdd(kind.id) }
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ProviderBadge(kind, size = 36.dp)
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(kind.displayName, style = FacetTheme.type.labelL, color = if (done) c.onPrimaryContainer else c.text)
                        Text(kind.blurb, style = FacetTheme.type.labelM.copy(fontWeight = FontWeight.Normal), color = if (done) c.onPrimaryContainer.copy(alpha = 0.8f) else c.textSecondary)
                    }
                    FacetIcon(if (done) R.drawable.ic_circle_check else R.drawable.ic_plus, null, tint = if (done) c.onPrimaryContainer else c.textTertiary, size = 20.dp)
                }
            }
        }
        if (!showAll) {
            Text(
                stringResource(R.string.onboarding_more_providers), style = FacetTheme.type.labelM, color = c.primary,
                modifier = Modifier.padding(top = 8.dp).clip(FacetShapes.small).clickable { showAll = true }.padding(8.dp),
            )
        }
        Spacer(Modifier.height(24.dp))
        FacetButton(
            stringResource(if (connected.isEmpty()) R.string.onboarding_skip_for_now else R.string.onboarding_start_chatting), onFinish,
            style = if (connected.isEmpty()) ButtonStyle.Tonal else ButtonStyle.Primary, modifier = Modifier.fillMaxWidth(),
        )
    }
}
