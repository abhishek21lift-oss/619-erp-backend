import AppIntents
import Foundation

/// "Hey Siri, how many clients do I have in MY PT STUDIO?"
///
/// ## The chain
///
/// Siri → this intent → the MY PT STUDIO voice API → auth + organization
/// check → database → result → Siri. The intent is the thinnest possible link
/// in that chain: it reads a token from the Keychain, makes one GET, and reads
/// the returned sentence aloud. It holds no credentials, builds no query, and
/// knows nothing about organizations — every decision about *what may be
/// counted* is the server's.
///
/// ## Read-only, on purpose
///
/// `isDiscoverable` is true so Siri and Shortcuts can surface it, but there is
/// no write counterpart and no parameter. An intent that runs from a locked
/// device should not be able to change anything, and one that takes no input
/// cannot be steered into asking about somebody else's studio.
@available(iOS 16.0, *)
struct GetClientCountIntent: AppIntent {

    static var title: LocalizedStringResource = "Get Client Count"

    static var description = IntentDescription(
        "Asks MY PT STUDIO how many active clients you have.",
        categoryName: "Dashboard",
        searchKeywords: ["clients", "roster", "how many", "count"]
    )

    /// The answer is spoken, so there is nothing to bring the app forward for.
    static var openAppWhenRun: Bool = false

    /// Runs from the lock screen. The Keychain item is stored
    /// `AfterFirstUnlock`, so the token is readable without the user unlocking
    /// first — which is the entire point of asking by voice.
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let client = VoiceAPIClient.fromBundle() else {
            // A build that shipped without MPS_API_BASE_URL, or with an http
            // one. Say so plainly rather than failing silently.
            throw VoiceAPIError.notConfigured
        }

        do {
            let result = try await client.clientCount()
            // The server's sentence, spoken verbatim — including the zero
            // case, which is a real answer ("You have 0 active clients.")
            // rather than an error.
            return .result(dialog: IntentDialog(stringLiteral: result.spoken))
        } catch let error as VoiceAPIError {
            // Each case already carries a sentence naming the remedy: sign in,
            // check your connection, try again shortly. Rethrowing the raw
            // error would have Siri say something generic instead.
            throw error
        }
    }
}

/// Makes the phrase work without the user adding a Shortcut first.
///
/// `applicationName` resolves to the app's display name, so the same phrases
/// keep working if it is ever renamed. Several phrasings are provided because
/// people do not say the one sentence a developer thought of.
@available(iOS 16.0, *)
struct MyPtStudioShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetClientCountIntent(),
            phrases: [
                "How many clients do I have in \(.applicationName)",
                "How many clients in \(.applicationName)",
                "Client count in \(.applicationName)",
                "\(.applicationName) client count",
            ],
            shortTitle: "Client Count",
            systemImageName: "person.3.fill"
        )
    }
}
