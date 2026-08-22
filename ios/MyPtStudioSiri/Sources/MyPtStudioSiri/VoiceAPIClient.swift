import Foundation

/// What the voice endpoints return: a number, and the sentence to say.
///
/// `spoken` comes from the server rather than being assembled here, so the
/// phrasing and its pluralisation can be corrected without an App Store
/// release. The client's job is to read it out, not to write it.
struct ClientCountResponse: Decodable {
    let count: Int
    let scope: String
    let spoken: String
}

/// One client, as the voice surface is willing to describe them.
///
/// Four facts and no contact details — the server does not select mobile,
/// email or address at all, so there is nothing here to leak by accident.
struct VoiceClient: Decodable, Identifiable {
    let id: String
    let clientId: String?
    let name: String
    let status: String?
    let packageType: String?
    let expiresOn: String?
    /// `nil` when the client has no end date on file: unknown, not lapsed.
    let expired: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case clientId = "client_id"
        case name
        case status
        case packageType = "package_type"
        case expiresOn = "expires_on"
        case expired
    }
}

struct ClientSearchResponse: Decodable {
    let query: String
    let count: Int
    let results: [VoiceClient]
    let spoken: String
}

/// Today's workout, as one of four states.
///
/// `none` and `unknown` are different answers and must stay different: one
/// says nothing was scheduled, the other says the log could not be read. A
/// voice surface that reports an unread log as "nothing scheduled" tells a
/// trainer their client has no session when they may well have one.
struct TodaySession: Decodable {
    let status: String
    let programName: String?

    enum CodingKeys: String, CodingKey {
        case status
        case programName = "program_name"
    }
}

/// One client in the detail a trainer actually asks for.
///
/// Still no contact details: the server does not select mobile, email or
/// address for this endpoint either. `sessionsRemaining` is optional because
/// "no balance on file" and "0 left" are different facts — collapsing the
/// first into the second would have Siri announce that a client has run out
/// when nothing was ever recorded.
struct ClientDetailResponse: Decodable {
    let id: String
    let name: String
    let status: String?
    let active: Bool
    let packageType: String?
    let expiresOn: String?
    /// `nil` when no end date is on file: unknown, not lapsed.
    let expired: Bool?
    /// `nil` when no balance is on file: unknown, not zero.
    let sessionsRemaining: Int?
    let today: TodaySession?
    let spoken: String

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case status
        case active
        case packageType = "package_type"
        case expiresOn = "expires_on"
        case expired
        case sessionsRemaining = "sessions_remaining"
        case today
        case spoken
    }
}

/// Every way this can fail, phrased as something Siri can say.
///
/// The distinction that matters is `unauthorized` vs `network`: one is fixed
/// by opening the app and signing in, the other by trying again in a moment.
/// Collapsing them into "something went wrong" sends the user to the wrong
/// remedy, which on a voice surface they cannot see or work around.
enum VoiceAPIError: LocalizedError {
    case notConfigured
    case notSignedIn
    case unauthorized
    case invalidQuery
    case notFound
    case rateLimited
    case server(status: Int)
    case network(underlying: Error)
    case malformedResponse

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "MY PT STUDIO is not set up on this device yet."
        case .notSignedIn, .unauthorized:
            return "Please sign in to MY PT STUDIO first."
        case .invalidQuery:
            // The server bounds `q` at 2–60 characters. Say what to do about
            // it rather than reporting a validation failure.
            return "Please say at least two letters of the name."
        case .notFound:
            // Also what the server returns for a client belonging to ANOTHER
            // studio, deliberately — so this sentence must not distinguish
            // "gone" from "not yours". Saying "you do not have access to that
            // client" would confirm the id exists somewhere, which is the
            // thing the 404 is there to avoid.
            return "I could not find that client."
        case .rateLimited:
            return "Too many requests just now. Please try again in a moment."
        case .server:
            return "MY PT STUDIO could not answer that right now."
        case .network:
            return "I could not reach MY PT STUDIO. Check your connection."
        case .malformedResponse:
            return "MY PT STUDIO sent back something unexpected."
        }
    }
}

/// Talks to the MY PT STUDIO voice API.
///
/// ## No secrets in here
///
/// There is no API key, no client secret and no base URL literal in this file.
/// The base URL comes from the app's Info.plist (build configuration) and the
/// bearer token comes from the Keychain, written by the host app when the user
/// signs in normally. An intent never sees credentials, only a token that the
/// user's own sign-in produced.
///
/// ## The intent never sends a query
///
/// It sends a path and a bearer token. It does not send an organization id —
/// the server derives that from the session — so there is nothing this client
/// could set, by accident or otherwise, that would widen what it can read.
struct VoiceAPIClient {

    /// Keychain account name the host app writes the session token under.
    static let tokenAccount = "com.myptstudio.session.token"

    private let baseURL: URL
    private let accessGroup: String?
    private let session: URLSession

    /// - Parameters:
    ///   - baseURL: the API origin, from `MPS_API_BASE_URL` in Info.plist.
    ///   - accessGroup: the shared keychain group; nil in unit tests.
    init(baseURL: URL, accessGroup: String?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.accessGroup = accessGroup
        self.session = session
    }

    /// Build from the app's own configuration, or nil when it is missing.
    static func fromBundle(_ bundle: Bundle = .main) -> VoiceAPIClient? {
        guard
            let raw = bundle.object(forInfoDictionaryKey: "MPS_API_BASE_URL") as? String,
            let url = URL(string: raw),
            // https only. A voice token must never be sent in the clear, and a
            // misconfigured http base URL is a silent downgrade rather than a
            // visible failure.
            url.scheme == "https"
        else { return nil }

        let group = bundle.object(forInfoDictionaryKey: "MPS_KEYCHAIN_ACCESS_GROUP") as? String
        return VoiceAPIClient(baseURL: url, accessGroup: group)
    }

    /// GET /api/voice/dashboard/client-count
    func clientCount() async throws -> ClientCountResponse {
        try await get("api/voice/dashboard/client-count")
    }

    /// GET /api/voice/clients/search?q=…
    ///
    /// The term is percent-encoded into the query string; it is the only thing
    /// this client ever sends besides the token. No organization id, no
    /// trainer id, no field list — every decision about what may be returned
    /// belongs to the server.
    func searchClients(matching term: String) async throws -> ClientSearchResponse {
        let trimmed = term.trimmingCharacters(in: .whitespacesAndNewlines)
        // Checked here as well as on the server so an obviously-empty phrase
        // is answered instantly instead of costing a round trip and a 400.
        guard trimmed.count >= 2 else { throw VoiceAPIError.invalidQuery }

        var components = URLComponents(
            url: baseURL.appendingPathComponent("api/voice/clients/search"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "q", value: trimmed)]
        guard let url = components?.url else { throw VoiceAPIError.invalidQuery }

        return try await get(url)
    }

    /// GET /api/voice/clients/:clientId
    ///
    /// Takes the opaque id Phase 2's search already returned — the intent
    /// never constructs one, and the server checks that the id belongs to the
    /// caller's organization before it reads anything. An id from another
    /// studio comes back 404, not 403, so a caller cannot use this endpoint to
    /// learn which ids exist.
    func clientDetail(id: String) async throws -> ClientDetailResponse {
        // Matched to the server's own bound on the path parameter. Checked
        // here so a malformed id fails locally instead of being encoded into
        // a path and sent — there is no id worth a round trip that this
        // rejects.
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard
            !id.isEmpty, id.count <= 64,
            id.unicodeScalars.allSatisfy({ allowed.contains($0) })
        else { throw VoiceAPIError.notFound }

        return try await get("api/voice/clients/\(id)")
    }

    // MARK: - Transport

    /// One request path for every voice endpoint.
    ///
    /// Both callers above go through this, so authentication, timeouts and the
    /// status-code mapping exist once. A third endpoint adds a method here,
    /// not a second client.
    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await get(baseURL.appendingPathComponent(path))
    }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        guard let token = Keychain.get(account: Self.tokenAccount, accessGroup: accessGroup) else {
            throw VoiceAPIError.notSignedIn
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Siri gives an intent a short budget before it is considered stalled;
        // a request that outlives that is better failed than left hanging.
        request.timeoutInterval = 10

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw VoiceAPIError.network(underlying: error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw VoiceAPIError.malformedResponse
        }

        switch http.statusCode {
        case 200:
            break
        case 400:
            // The server rejected the term's length. Distinct from a server
            // fault: the user can fix it by saying more of the name.
            throw VoiceAPIError.invalidQuery
        case 401:
            // The token expired or was revoked. Nothing is retried and nothing
            // is refreshed here: re-authentication belongs to the host app,
            // where the user can actually see what they are signing into.
            throw VoiceAPIError.unauthorized
        case 403:
            // A staff-only surface reached by a client account. Same remedy as
            // signing in, from the user's point of view.
            throw VoiceAPIError.unauthorized
        case 404:
            // Either the client is gone or it was never this studio's. The
            // server returns the same status for both on purpose and so does
            // this — see `.notFound`.
            throw VoiceAPIError.notFound
        case 429:
            throw VoiceAPIError.rateLimited
        default:
            throw VoiceAPIError.server(status: http.statusCode)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw VoiceAPIError.malformedResponse
        }
    }
}
