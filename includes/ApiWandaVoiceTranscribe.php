<?php

namespace MediaWiki\Extension\WandaVoice;

use ApiBase;
use MediaWiki\MediaWikiServices;
use Wikimedia\ParamValidator\ParamValidator;

/**
 * API module that transcribes a short audio clip using a server-side
 * speech-to-text service (T410215).
 *
 * This powers the "server" recognition engine, which provides voice input on
 * browsers without a SpeechRecognition implementation (notably Firefox).
 * The client records a silence-delimited utterance with MediaRecorder and
 * posts it here as base64; the module forwards it to the configured
 * Whisper-compatible endpoint (OpenAI audio/transcriptions contract, also
 * implemented by self-hosted servers such as LocalAI and faster-whisper for
 * privacy-first setups) and returns the transcript text.
 *
 * The STT endpoint and API key stay server-side and are never exposed to the
 * browser. Audio is forwarded only; it is never written to disk or logged.
 */
class ApiWandaVoiceTranscribe extends ApiBase {

	/** Accepted audio MIME types mapped to upload file extensions. */
	private const MIME_EXTENSIONS = [
		'audio/webm' => 'webm',
		'audio/ogg' => 'ogg',
		'audio/mp4' => 'mp4',
		'audio/mpeg' => 'mp3',
		'audio/wav' => 'wav'
	];

	public function execute() {
		$config = $this->getConfig();

		if ( !$config->get( 'WandaVoiceEnabled' ) ) {
			$this->dieWithError( 'wandavoice-api-error-disabled', 'wandavoice-disabled' );
		}

		$endpoint = (string)$config->get( 'WandaVoiceSTTEndpoint' );
		if ( $endpoint === '' ) {
			$this->dieWithError( 'wandavoice-api-error-stt-disabled', 'wandavoice-stt-disabled' );
		}

		// Honour a 'wandavoice-transcribe' rate limit when the wiki defines
		// one in $wgRateLimits (outbound STT requests cost money/CPU).
		if ( $this->getUser()->pingLimiter( 'wandavoice-transcribe' ) ) {
			$this->dieWithError( 'apierror-ratelimited', 'ratelimited' );
		}

		$params = $this->extractRequestParams();

		$mime = strtolower( trim( (string)$params['mimetype'] ) );
		if ( !isset( self::MIME_EXTENSIONS[$mime] ) ) {
			$this->dieWithError( 'wandavoice-api-error-stt-badaudio', 'wandavoice-stt-badaudio' );
		}

		$maxSize = (int)$config->get( 'WandaVoiceMaxAudioSize' );
		$audioB64 = (string)$params['audio'];
		// Base64 expands data by 4/3; reject oversized payloads before decoding.
		if ( strlen( $audioB64 ) > (int)ceil( $maxSize * 4 / 3 ) + 8 ) {
			$this->dieWithError( 'wandavoice-api-error-stt-toolarge', 'wandavoice-stt-toolarge' );
		}

		$audio = base64_decode( $audioB64, true );
		if ( $audio === false || $audio === '' ) {
			$this->dieWithError( 'wandavoice-api-error-stt-badaudio', 'wandavoice-stt-badaudio' );
		}
		if ( strlen( $audio ) > $maxSize ) {
			$this->dieWithError( 'wandavoice-api-error-stt-toolarge', 'wandavoice-stt-toolarge' );
		}

		$text = $this->requestTranscription( $audio, $mime, (string)$params['lang'] );
		if ( $text === null ) {
			$this->dieWithError( 'wandavoice-api-error-stt-failed', 'wandavoice-stt-failed' );
		}

		$result = $this->getResult();
		$result->addValue( null, 'success', true );
		$result->addValue( null, 'text', $text );
		$result->addValue( null, 'engine', 'server' );
	}

	/**
	 * Forward the audio to the configured Whisper-compatible endpoint.
	 *
	 * @param string $audio Raw audio bytes
	 * @param string $mime Whitelisted MIME type
	 * @param string $lang BCP 47 tag of the voice input, if known
	 * @return string|null Transcript text, or null on failure
	 */
	private function requestTranscription( string $audio, string $mime, string $lang ): ?string {
		$config = $this->getConfig();
		$endpoint = (string)$config->get( 'WandaVoiceSTTEndpoint' );
		$apiKey = (string)$config->get( 'WandaVoiceSTTApiKey' );
		$model = (string)$config->get( 'WandaVoiceSTTModel' );
		$timeout = (int)$config->get( 'WandaVoiceSTTTimeout' );

		$fields = [
			'model' => $model,
			'response_format' => 'json'
		];
		// Whisper expects an ISO 639-1 code ("en"), not a full BCP 47 tag.
		$langCode = strtolower( trim( explode( '-', $lang )[0] ) );
		if ( $langCode !== '' && preg_match( '/^[a-z]{2,3}$/', $langCode ) ) {
			$fields['language'] = $langCode;
		}

		$boundary = '----WandaVoice' . bin2hex( random_bytes( 16 ) );
		$eol = "\r\n";
		$body = '';
		foreach ( $fields as $name => $value ) {
			$body .= '--' . $boundary . $eol;
			$body .= 'Content-Disposition: form-data; name="' . $name . '"' . $eol . $eol;
			$body .= $value . $eol;
		}
		$body .= '--' . $boundary . $eol;
		$body .= 'Content-Disposition: form-data; name="file"; filename="audio.' .
			self::MIME_EXTENSIONS[$mime] . '"' . $eol;
		$body .= 'Content-Type: ' . $mime . $eol . $eol;
		$body .= $audio . $eol;
		$body .= '--' . $boundary . '--' . $eol;

		$request = MediaWikiServices::getInstance()->getHttpRequestFactory()->create(
			$endpoint,
			[
				'method' => 'POST',
				'timeout' => $timeout,
				'postData' => $body
			],
			__METHOD__
		);
		$request->setHeader( 'Content-Type', 'multipart/form-data; boundary=' . $boundary );
		if ( $apiKey !== '' ) {
			$request->setHeader( 'Authorization', 'Bearer ' . $apiKey );
		}

		$status = $request->execute();
		if ( !$status->isOK() ) {
			return null;
		}

		$data = json_decode( $request->getContent(), true );
		if ( !is_array( $data ) || !isset( $data['text'] ) || !is_string( $data['text'] ) ) {
			return null;
		}

		$text = trim( $data['text'] );
		return $text !== '' ? $text : null;
	}

	/** @inheritDoc */
	public function mustBePosted() {
		return true;
	}

	/** @inheritDoc */
	public function getAllowedParams() {
		return [
			'audio' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_REQUIRED => true
			],
			'mimetype' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_DEFAULT => 'audio/webm'
			],
			'lang' => [
				ParamValidator::PARAM_TYPE => 'string',
				ParamValidator::PARAM_DEFAULT => ''
			]
		];
	}

	/** @inheritDoc */
	protected function getExamplesMessages() {
		return [
			'action=wandavoicetranscribe&audio=BASE64AUDIO&mimetype=audio/webm&format=json'
				=> 'apihelp-wandavoicetranscribe-example-simple'
		];
	}
}
