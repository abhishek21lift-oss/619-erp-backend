import AppIntents
import Foundation

/// "Hey Siri, show me Rahul's details in MY PT STUDIO."
///
/// ## Why this is an ENTITY parameter and not a string
///
/// Phase 2's `FindClientIntent` takes a name and speaks whatever the server
/// says — including "I found 2 people matching Rahul", because with only a
/// name to go on, naming both is the honest answer.
///
/// This intent has to go further: it retrieves ONE person's package and
/// session state. So the thing it takes is not a name but a client, resolved
/// from a name by `ClientEntityQuery`. When two Rahuls match, App Intents
/// asks the user which one — the disambiguation is the framework's, driven by
/// the entity's `DisplayRepresentation`, and it happens BEFORE any detail is
/// fetched. Guessing a "best" match would have Siri state one person's expiry
/// date with total confidence when it may be the other's, and the user cannot
/// see that a choice was made.
///
/// ## What the id is and is not
///
/// The entity's `id` is the opaque `pt_clients` handle the search endpoint
/// already returned. It is passed back on the next request and never spoken:
/// the server's sentence names a person and a package, never an identifier.
/// Holding one grants nothing on its own — the server re-checks on every call
/// that the id belongs to the caller's own organization, and answers 404 when
/// it does not.
@available(iOS 16.0, *)
struct GetClientDetailIntent: AppIntent {

    static var title: LocalizedStringResource = "Get Client Details"

    static var description = IntentDescription(
        "Says a client's package, expiry, sessions left and today's workout.",
        categoryName: "Clients",
        searchKeywords: ["details", "package", "sessions", "expiry", "workout"]
    )

    static var openAppWhenRun: Bool = false

    /// Runs from the lock screen, like the other two. The Keychain item is
    /// stored `AfterFirstUnlock`, so the token is readable there.
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed

    /// The client to describe.
    ///
    /// Spoken as a name; resolved to one client by `ClientEntityQuery`. Zero
    /// matches re-prompts, several matches disambiguate — neither case is
    /// handled in `perform()`, because by the time it runs the parameter is
    /// already exactly one person.
    @Parameter(
        title: "Client",
        requestValueDialog: IntentDialog("Whose details would you like?")
    )
    var client: ClientEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Get details for \(\.$client) in MY PT STUDIO")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        do {
            let detail = try await api.clientDetail(id: client.id)
            // The server's sentence, verbatim. It already handles the missing
            // package, the expired package, the unknown balance and the four
            // states of today's workout — and keeping the wording server-side
            // means it can be corrected without an App Store release.
            return .result(dialog: IntentDialog(stringLiteral: detail.spoken))
        } catch let error as VoiceAPIError {
            // Every case carries a sentence naming a remedy — sign in, try
            // again shortly, check your connection. `.notFound` covers both a
            // deleted client and one that was never this studio's, and says
            // the same thing for both on purpose.
            throw error
        }
    }
}

/// A client, as Siri is allowed to show and say them.
///
/// Two facts in the display: a name, and the package under it. That is enough
/// to tell two Rahuls apart during disambiguation and it is deliberately not
/// enough to be worth reading over someone's shoulder — no phone number, no
/// email, no address, none of which the server sends in the first place.
@available(iOS 16.0, *)
struct ClientEntity: AppEntity, Identifiable {

    /// The opaque `pt_clients` id. Never spoken.
    let id: String
    let name: String
    let packageType: String?

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Client"

    static var defaultQuery = ClientEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        // Typed explicitly rather than leaning on inference through
        // `Optional.map`: `LocalizedStringResource` is string-interpolatable,
        // so the shorter spelling compiles but binds to whichever type the
        // checker settles on first.
        let subtitle: LocalizedStringResource
        if let packageType {
            subtitle = "\(packageType)"
        } else {
            subtitle = "No package on file"
        }
        return DisplayRepresentation(title: "\(name)", subtitle: subtitle)
    }

    init(id: String, name: String, packageType: String?) {
        self.id = id
        self.name = name
        self.packageType = packageType
    }

    init(_ c: VoiceClient) {
        self.init(id: c.id, name: c.name, packageType: c.packageType)
    }
}

/// Turns a spoken name into clients, and an id back into a client.
///
/// ## `suggestedEntities` is deliberately empty
///
/// `EntityQuery` offers it as the list Shortcuts shows when someone taps the
/// parameter with nothing typed. Filling it would mean pushing the studio's
/// roster into the Shortcuts UI — names on screen, cached by the system,
/// visible to anyone holding the phone — in exchange for saving a search
/// nobody asked to skip. The roster is fetched when a name is spoken, and not
/// before.
@available(iOS 16.0, *)
struct ClientEntityQuery: EntityQuery, EntityStringQuery {

    /// Spoken name → candidates. Returning several is what makes Siri ask
    /// which one; the choice is the user's and is made before any detail is
    /// read.
    func entities(matching string: String) async throws -> [ClientEntity] {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }
        let found = try await api.searchClients(matching: string)
        return found.results.map(ClientEntity.init)
    }

    /// Id → client, for a parameter the system has already resolved once (a
    /// saved Shortcut, or a value carried between intents).
    ///
    /// Each id goes back through the API, so a client who has since been
    /// deleted — or who was never this caller's to read — resolves to nothing
    /// rather than to a stale name held on the device. A saved Shortcut is
    /// not a standing grant.
    func entities(for identifiers: [String]) async throws -> [ClientEntity] {
        guard let api = VoiceAPIClient.fromBundle() else {
            throw VoiceAPIError.notConfigured
        }

        var found: [ClientEntity] = []
        for id in identifiers {
            do {
                let detail = try await api.clientDetail(id: id)
                found.append(ClientEntity(
                    id: detail.id,
                    name: detail.name,
                    packageType: detail.packageType
                ))
            } catch VoiceAPIError.notFound {
                // Gone, or never ours. Drop it — resolving to nothing is the
                // correct outcome and lets the system re-prompt.
                continue
            }
        }
        return found
    }

    /// See the type's note: the roster is not pushed into the Shortcuts UI.
    func suggestedEntities() async throws -> [ClientEntity] { [] }
}
