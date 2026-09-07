<?php
/**
 * Hook to add the WandaVoice interface to wiki pages
 *
 * @file
 * @ingroup WandaVoice
 */

namespace MediaWiki\Extension\WandaVoice\Hooks;

use ExtensionRegistry;
use MediaWiki\MediaWikiServices;
use OutputPage;
use Skin;

/**
 * Hooks for adding the WandaVoice floating panel to pages
 */
class VoiceHooks {

	/**
	 * Add the WandaVoice module and its client configuration to pages.
	 *
	 * @param OutputPage $out
	 * @param Skin $skin
	 * @return void
	 */
	public static function onBeforePageDisplay( OutputPage $out, Skin $skin ): void {
		$services = MediaWikiServices::getInstance();
		$config = $services->getMainConfig();

		if ( !$config->get( 'WandaVoiceEnabled' ) ) {
			return;
		}

		// WandaVoice builds on Wanda's LLM infrastructure.
		if ( !ExtensionRegistry::getInstance()->isLoaded( 'Wanda' ) ) {
			return;
		}

		// Namespace restriction ([] = available everywhere).
		$namespaces = $config->get( 'WandaVoiceNamespaces' );
		$title = $out->getTitle();
		if ( $namespaces && $title && !in_array( $title->getNamespace(), $namespaces ) ) {
			return;
		}

		// Optionally keep the interface off the mobile view.
		if ( !$config->get( 'WandaVoiceMobileEnabled' )
			&& ExtensionRegistry::getInstance()->isLoaded( 'MobileFrontend' )
		) {
			$mobileContext = $services->getService( 'MobileFrontend.Context' );
			if ( $mobileContext->shouldDisplayMobileView() ) {
				return;
			}
		}

		$language = $config->get( 'WandaVoiceLanguage' );
		if ( $language === '' ) {
			$language = $services->getContentLanguage()->getHtmlCode();
		}

		$out->addJsConfigVars( [
			'wgWandaVoice' => [
				'wakePhrase' => $config->get( 'WandaVoiceWakePhrase' ),
				'wakeSensitivity' => (float)$config->get( 'WandaVoiceWakeSensitivity' ),
				'continuousMode' => (bool)$config->get( 'WandaVoiceContinuousMode' ),
				'language' => $language,
				'fallbackLanguages' => $config->get( 'WandaVoiceFallbackLanguages' ),
				'recognitionEngine' => $config->get( 'WandaVoiceRecognitionEngine' ),
				// Only a boolean flag: the endpoint and key stay server-side.
				'serverSTT' => $config->get( 'WandaVoiceSTTEndpoint' ) !== '',
				'useLLM' => (bool)$config->get( 'WandaVoiceUseLLM' ),
				'showThinking' => (bool)$config->get( 'WandaVoiceShowThinking' ),
				'audioFeedback' => (bool)$config->get( 'WandaVoiceAudioFeedback' ),
				'visualIndicators' => (bool)$config->get( 'WandaVoiceVisualIndicators' ),
				'hapticFeedback' => (bool)$config->get( 'WandaVoiceHapticFeedback' ),
				'customCommands' => (object)$config->get( 'WandaVoiceCustomCommands' ),
				'offlineCommands' => $config->get( 'WandaVoiceOfflineCommands' )
			]
		] );

		$out->addHeadItem(
			'wandavoice-definecomponent',
			'<script>window.defineComponent = window.defineComponent || function ( obj ) { return obj; };</script>'
		);
		$out->addModules( 'ext.wandavoice' );
	}
}
