import assert from 'node:assert/strict';
import {
  getOrCreateDeviceIdentityKeyPair,
  syncPublicKeyToSupabase,
  fetchAndVerifyPeerKeyBundle,
  verifyPublishedKeyBundleIntegrity,
  rotateLocalDeviceKeys,
  approvePeerKeyRotation,
  deriveDirectionalCallSignalKey,
  encryptE2EEMessage,
  signCallSignalCanonical,
  purgeCryptoSessionMemory,
  enableHeadlessTestKeyRegistry,
} from '../cryptoService';
import {
  CallCryptoSessionBundle,
  SignalReplayDetector,
  createSignedEncryptedSignal,
  verifySignedEncryptedSignal,
  serializeCanonicalCallSignal,
  validateOneToOneConversationMembership,
  isSignalAllowedInCallState,
  generateUniqueSignalId,
  OneToOneVoiceCallManager,
} from '../callService';
import {
  SUPABASE_MIGRATION_SQL,
  SUPABASE_SETUP_SQL,
  SUPABASE_SECTION_13_VALIDATION_SQL,
} from '../supabaseSql';
import { PublishedUserCryptoKeyBundle, VoiceCallSignalMessage } from '../../types';

async function buildParticipantCryptoBundles(
  userAId: string,
  userBId: string,
  conversationId: string
): Promise<{
  bundleA: CallCryptoSessionBundle;
  bundleB: CallCryptoSessionBundle;
  keysA: Awaited<ReturnType<typeof getOrCreateDeviceIdentityKeyPair>>;
  keysB: Awaited<ReturnType<typeof getOrCreateDeviceIdentityKeyPair>>;
}> {
  const [keysA, keysB] = await Promise.all([
    getOrCreateDeviceIdentityKeyPair(userAId),
    getOrCreateDeviceIdentityKeyPair(userBId),
  ]);

  await Promise.all([
    syncPublicKeyToSupabase(userAId, keysA.publishedBundle),
    syncPublicKeyToSupabase(userBId, keysB.publishedBundle),
  ]);

  const [verifiedBForA, verifiedAForB] = await Promise.all([
    fetchAndVerifyPeerKeyBundle(userAId, userBId),
    fetchAndVerifyPeerKeyBundle(userBId, userAId),
  ]);

  assert.equal(verifiedBForA.trusted, true, 'User A must verify & pin User B key bundle');
  assert.equal(verifiedAForB.trusted, true, 'User B must verify & pin User A key bundle');

  const [aOutKey, aInKey, bOutKey, bInKey] = await Promise.all([
    deriveDirectionalCallSignalKey(
      keysA.privateKey,
      verifiedBForA.ecdhPublicKey!,
      conversationId,
      userAId,
      userBId
    ),
    deriveDirectionalCallSignalKey(
      keysA.privateKey,
      verifiedBForA.ecdhPublicKey!,
      conversationId,
      userBId,
      userAId
    ),
    deriveDirectionalCallSignalKey(
      keysB.privateKey,
      verifiedAForB.ecdhPublicKey!,
      conversationId,
      userBId,
      userAId
    ),
    deriveDirectionalCallSignalKey(
      keysB.privateKey,
      verifiedAForB.ecdhPublicKey!,
      conversationId,
      userAId,
      userBId
    ),
  ]);

  const bundleA: CallCryptoSessionBundle = {
    localUserId: userAId,
    peerUserId: userBId,
    conversationId,
    outboundAesKey: aOutKey,
    inboundAesKey: aInKey,
    localSigningPrivateKey: keysA.signingPrivateKey,
    peerVerifyPublicKey: verifiedBForA.ecdsaVerifyPublicKey!,
    localEcdsaFingerprint: keysA.ecdsaFingerprint,
    peerEcdsaFingerprint: verifiedBForA.ecdsaFingerprint!,
    localKeyRotationVersion: keysA.keyRotationVersion,
    peerKeyRotationVersion: verifiedBForA.keyRotationVersion!,
  };

  const bundleB: CallCryptoSessionBundle = {
    localUserId: userBId,
    peerUserId: userAId,
    conversationId,
    outboundAesKey: bOutKey,
    inboundAesKey: bInKey,
    localSigningPrivateKey: keysB.signingPrivateKey,
    peerVerifyPublicKey: verifiedAForB.ecdsaVerifyPublicKey!,
    localEcdsaFingerprint: keysB.ecdsaFingerprint,
    peerEcdsaFingerprint: verifiedAForB.ecdsaFingerprint!,
    localKeyRotationVersion: keysB.keyRotationVersion,
    peerKeyRotationVersion: verifiedAForB.keyRotationVersion!,
  };

  return { bundleA, bundleB, keysA, keysB };
}

export async function runCallSecurityTestSuite(): Promise<void> {
  enableHeadlessTestKeyRegistry(true);
  purgeCryptoSessionMemory();

  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const userC = '33333333-3333-4333-8333-333333333333';
  const convId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  console.log('=== Spark Phase 1 Voice Calling — Final Security Test Suite ===\n');

  // ---------------------------------------------------------------------------
  // 1. Key Separation (ECDH vs ECDSA) & Non-Extractable Private Key Storage
  // ---------------------------------------------------------------------------
  {
    const keysA = await getOrCreateDeviceIdentityKeyPair(userA);

    // Verify algorithm separation
    assert.equal(keysA.privateKey.algorithm.name, 'ECDH', 'ECDH private key must have ECDH algorithm');
    assert.equal(
      keysA.signingPrivateKey.algorithm.name,
      'ECDSA',
      'ECDSA signing private key must have ECDSA algorithm'
    );

    // Verify both private keys are non-extractable from birth
    assert.equal(keysA.privateKey.extractable, false, 'ECDH private key must have extractable=false');
    assert.equal(
      keysA.signingPrivateKey.extractable,
      false,
      'ECDSA signing private key must have extractable=false'
    );

    // Attempting to export either private key must throw InvalidAccessError
    await assert.rejects(
      async () => globalThis.crypto.subtle.exportKey('jwk', keysA.privateKey),
      /InvalidAccessError|not extractable/i,
      'Exporting non-extractable ECDH private key must fail'
    );
    await assert.rejects(
      async () => globalThis.crypto.subtle.exportKey('jwk', keysA.signingPrivateKey),
      /InvalidAccessError|not extractable/i,
      'Exporting non-extractable ECDSA signing private key must fail'
    );

    // Verify public keys have distinct coordinates and fingerprints
    const pubBundle = keysA.publishedBundle;
    assert.notEqual(
      pubBundle.ecdhPublicKey.x,
      pubBundle.ecdsaSigningPublicKey.x,
      'ECDH and ECDSA public keys must never share curve coordinate x'
    );
    assert.notEqual(
      pubBundle.ecdhPublicKey.fingerprint,
      pubBundle.ecdsaSigningPublicKey.fingerprint,
      'ECDH and ECDSA public keys must have distinct fingerprints'
    );

    // Verify that a malformed bundle reusing the ECDH coordinates for ECDSA is rejected
    const reusedKeyBundle: PublishedUserCryptoKeyBundle = {
      ...pubBundle,
      ecdsaSigningPublicKey: {
        ...pubBundle.ecdsaSigningPublicKey,
        x: pubBundle.ecdhPublicKey.x,
        y: pubBundle.ecdhPublicKey.y,
      },
    };
    const reuseCheck = await verifyPublishedKeyBundleIntegrity(userA, reusedKeyBundle);
    assert.equal(
      reuseCheck.valid,
      false,
      'Bundle reusing ECDH public key coordinates for ECDSA MUST be rejected'
    );
    assert.match(reuseCheck.reason || '', /Key separation violation/i);

    console.log(
      '✓ [PASS] 1. Separate non-extractable ECDH & ECDSA P-256 keys and reuse rejection'
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Identity Binding, TOFU Pinning, Key Rotation & Mismatch Rejection
  // ---------------------------------------------------------------------------
  {
    purgeCryptoSessionMemory();
    const [keysA, keysB] = await Promise.all([
      getOrCreateDeviceIdentityKeyPair(userA),
      getOrCreateDeviceIdentityKeyPair(userB),
    ]);
    await Promise.all([
      syncPublicKeyToSupabase(userA, keysA.publishedBundle),
      syncPublicKeyToSupabase(userB, keysB.publishedBundle),
    ]);

    // 2a. First fetch pins the key bundle (pinned_first_use)
    const firstPin = await fetchAndVerifyPeerKeyBundle(userA, userB);
    assert.equal(firstPin.trusted, true);
    assert.equal(firstPin.status, 'pinned_first_use');
    assert.equal(firstPin.keyRotationVersion, 1);

    // 2b. Second fetch with identical bundle matches the existing pin (matched_pin)
    const secondPin = await fetchAndVerifyPeerKeyBundle(userA, userB);
    assert.equal(secondPin.trusted, true);
    assert.equal(secondPin.status, 'matched_pin');

    // 2c. Identity binding tampering (User C tries to claim User B's bundle for User C)
    const crossUserCheck = await verifyPublishedKeyBundleIntegrity(userC, keysB.publishedBundle);
    assert.equal(
      crossUserCheck.valid,
      false,
      'Key bundle bound to userB MUST be rejected when verified for userC'
    );

    // 2d. User B rotates their keys (v1 -> v2). User A fetches User B's new key bundle:
    // Spark MUST NOT silently trust the newly fetched signing key!
    const rotatedBundleB = await rotateLocalDeviceKeys(userB);
    assert.equal(rotatedBundleB.keyRotationVersion, 2);

    const unapprovedFetch = await fetchAndVerifyPeerKeyBundle(userA, userB);
    assert.equal(
      unapprovedFetch.trusted,
      false,
      'Newly fetched rotated signing key MUST NOT be silently trusted'
    );
    assert.equal(unapprovedFetch.status, 'key_mismatch_rejected');
    assert.equal(unapprovedFetch.keyMismatchDetected, true);

    // 2e. Explicit approval with wrong fingerprint must fail
    const wrongFpApproval = await approvePeerKeyRotation(
      userA,
      userB,
      rotatedBundleB,
      '0000000000000000000000000000000000000000000000000000000000000000'
    );
    assert.equal(wrongFpApproval.trusted, false);

    // 2f. Explicit approval with verified fingerprint and v2 > v1 succeeds
    const validApproval = await approvePeerKeyRotation(
      userA,
      userB,
      rotatedBundleB,
      rotatedBundleB.ecdsaSigningPublicKey.fingerprint
    );
    assert.equal(validApproval.trusted, true);
    assert.equal(validApproval.keyRotationVersion, 2);

    // 2g. Replay/downgrade attack: trying to re-present old v1 bundle after v2 is pinned MUST fail
    await syncPublicKeyToSupabase(userB, keysB.publishedBundle); // old v1 bundle
    const downgradeCheck = await fetchAndVerifyPeerKeyBundle(userA, userB);
    assert.equal(downgradeCheck.trusted, false);
    assert.equal(
      downgradeCheck.status,
      'version_downgrade_rejected',
      'Key version downgrade (v1 < pinned v2) MUST be rejected'
    );

    console.log(
      '✓ [PASS] 2. Cryptographic identity binding, TOFU pinning, key rotation & mismatch rejection'
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Impersonation, Key Mismatch & SDP/ICE Tampering Rejection
  // ---------------------------------------------------------------------------
  {
    purgeCryptoSessionMemory();
    const { bundleA, bundleB, keysA, keysB } = await buildParticipantCryptoBundles(
      userA,
      userB,
      convId
    );
    const keysC = await getOrCreateDeviceIdentityKeyPair(userC);

    // 3a. Participant B attempts to impersonate Participant A using the shared ECDH secret
    const forgedRaw: Omit<VoiceCallSignalMessage, 'cryptoProof'> = {
      signalId: generateUniqueSignalId(),
      callId: 'call_impersonate_1',
      conversationId: convId,
      senderId: userA,
      targetUserId: userB,
      type: 'call-end',
      reason: 'Forged hangup',
      timestamp: new Date().toISOString(),
    };
    const forgedCanonical = serializeCanonicalCallSignal(
      forgedRaw,
      bundleB.peerEcdsaFingerprint,
      bundleB.peerKeyRotationVersion
    );
    const directionalKeyAtoB = await deriveDirectionalCallSignalKey(
      keysB.privateKey,
      keysA.publicKey,
      convId,
      userA,
      userB
    );
    const forgedEncrypted = await encryptE2EEMessage(forgedCanonical, directionalKeyAtoB);
    const forgedSignatureByB = await signCallSignalCanonical(
      forgedCanonical,
      keysB.signingPrivateKey
    );

    const forgedPacket: VoiceCallSignalMessage = {
      ...forgedRaw,
      cryptoProof: {
        ciphertext: forgedEncrypted.ciphertext,
        iv: forgedEncrypted.iv,
        signature: forgedSignatureByB,
        version: 'ecdsa_p256_hkdf_aes256gcm_v2',
        senderEcdsaFingerprint: bundleB.peerEcdsaFingerprint,
        keyRotationVersion: bundleB.peerKeyRotationVersion,
      },
    };

    const impersonationCheck = await verifySignedEncryptedSignal(
      forgedPacket,
      convId,
      userA,
      userB,
      bundleB
    );
    assert.equal(impersonationCheck.valid, false);
    assert.match(
      impersonationCheck.reason || '',
      /ECDSA P-256 signature verification failed/i
    );

    // 3b. SDP tampering in transit
    const validOffer = await createSignedEncryptedSignal(
      {
        signalId: generateUniqueSignalId(),
        callId: 'call_sdp_tamper',
        conversationId: convId,
        senderId: userA,
        targetUserId: userB,
        type: 'webrtc-offer',
        timestamp: new Date().toISOString(),
        sdp: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 LEGITIMATE\r\n' },
      },
      bundleA
    );
    assert.ok(validOffer);

    const tamperedSdpOffer: VoiceCallSignalMessage = {
      ...validOffer,
      sdp: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 ATTACKER_MITM\r\n' },
    };
    const sdpTamperCheck = await verifySignedEncryptedSignal(
      tamperedSdpOffer,
      convId,
      userA,
      userB,
      bundleB
    );
    assert.equal(sdpTamperCheck.valid, false);

    // 3c. Third-party User C signature substitution
    const sigByC = await signCallSignalCanonical(
      serializeCanonicalCallSignal(
        validOffer,
        bundleA.localEcdsaFingerprint,
        bundleA.localKeyRotationVersion
      ),
      keysC.signingPrivateKey
    );
    const thirdPartySigPacket: VoiceCallSignalMessage = {
      ...validOffer,
      cryptoProof: {
        ...validOffer.cryptoProof!,
        signature: sigByC,
      },
    };
    const thirdPartyCheck = await verifySignedEncryptedSignal(
      thirdPartySigPacket,
      convId,
      userA,
      userB,
      bundleB
    );
    assert.equal(thirdPartyCheck.valid, false);

    console.log('✓ [PASS] 3. Impersonation, third-party signature & SDP/ICE tampering rejection');
  }

  // ---------------------------------------------------------------------------
  // 4. Verification Ordering Before SDP/ICE, Replay Protection & State Machine
  // ---------------------------------------------------------------------------
  {
    purgeCryptoSessionMemory();
    const { bundleA, bundleB } = await buildParticipantCryptoBundles(userA, userB, convId);
    const manager = new OneToOneVoiceCallManager();

    let setRemoteDescriptionCalls = 0;
    let addIceCandidateCalls = 0;

    // Spy RTCPeerConnection to prove invalidly signed / replayed / out-of-state signals
    // NEVER reach setRemoteDescription or addIceCandidate
    const spyPeerConnection = {
      signalingState: 'have-local-offer',
      remoteDescription: { type: 'answer', sdp: 'v=0\r\n' },
      setRemoteDescription: async () => {
        setRemoteDescriptionCalls += 1;
      },
      addIceCandidate: async () => {
        addIceCandidateCalls += 1;
      },
      close: () => {},
    } as unknown as RTCPeerConnection;

    manager.configureTestSessionForAudit({
      state: {
        status: 'connecting',
        callId: 'call_order_test_1',
        conversationId: convId,
        isCaller: true,
        peerUser: {
          id: userB,
          username: 'bob',
          display_name: 'Bob',
          avatar_url: 'https://example.com/bob.png',
        },
      },
      cryptoBundle: bundleA,
      mockPeerConnection: spyPeerConnection,
    });

    // 4a. Forged webrtc-answer from B with invalid signature MUST NOT call setRemoteDescription
    const legitimateAnswer = await createSignedEncryptedSignal(
      {
        signalId: generateUniqueSignalId(),
        callId: 'call_order_test_1',
        conversationId: convId,
        senderId: userB,
        targetUserId: userA,
        type: 'webrtc-answer',
        timestamp: new Date().toISOString(),
        sdp: { type: 'answer', sdp: 'v=0\r\na=sendrecv\r\n' },
      },
      bundleB
    );
    assert.ok(legitimateAnswer);

    const forgedAnswer: VoiceCallSignalMessage = {
      ...legitimateAnswer,
      sdp: { type: 'answer', sdp: 'v=0\r\na=INJECTED_MALICIOUS_SDP\r\n' },
    };

    const forgedResult = await manager.handleIncomingRoomSignal(
      forgedAnswer,
      convId,
      userB,
      userA
    );
    assert.equal(forgedResult, false, 'Forged webrtc-answer must be rejected');
    assert.equal(
      setRemoteDescriptionCalls,
      0,
      'setRemoteDescription MUST NOT be called when signature/payload verification fails'
    );

    // 4b. Because forgedAnswer failed crypto verification before replay commit, the authentic
    // legitimateAnswer (which shares the same signalId) has NOT been poisoned in the replay cache!
    const validAnswerResult = await manager.handleIncomingRoomSignal(
      legitimateAnswer,
      convId,
      userB,
      userA
    );
    assert.equal(validAnswerResult, true, 'Authentic webrtc-answer must be accepted');
    assert.equal(setRemoteDescriptionCalls, 1, 'setRemoteDescription called once for authentic answer');

    // 4c. Replaying the exact same authentic webrtc-answer MUST be blocked before setRemoteDescription
    const replayedAnswerResult = await manager.handleIncomingRoomSignal(
      legitimateAnswer,
      convId,
      userB,
      userA
    );
    assert.equal(replayedAnswerResult, false, 'Replayed webrtc-answer must be rejected');
    assert.equal(
      setRemoteDescriptionCalls,
      1,
      'setRemoteDescription MUST NOT be called on a replayed signal'
    );

    // 4d. Authentic ICE candidate vs replayed ICE candidate
    const validIce = await createSignedEncryptedSignal(
      {
        signalId: generateUniqueSignalId(),
        callId: 'call_order_test_1',
        conversationId: convId,
        senderId: userB,
        targetUserId: userA,
        type: 'webrtc-ice',
        timestamp: new Date().toISOString(),
        candidate: {
          candidate: 'candidate:1 1 UDP 2122252543 192.0.2.1 54321 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      },
      bundleB
    );
    assert.ok(validIce);

    const iceOk = await manager.handleIncomingRoomSignal(validIce, convId, userB, userA);
    assert.equal(iceOk, true);
    assert.equal(addIceCandidateCalls, 1);

    const iceReplay = await manager.handleIncomingRoomSignal(validIce, convId, userB, userA);
    assert.equal(iceReplay, false, 'Replayed ICE candidate must be rejected');
    assert.equal(addIceCandidateCalls, 1, 'addIceCandidate MUST NOT be called on replay');

    // 4e. Out-of-state transition (e.g. call-ringing while already in 'connecting' state)
    const outOfStateRinging = await createSignedEncryptedSignal(
      {
        signalId: generateUniqueSignalId(),
        callId: 'call_order_test_1',
        conversationId: convId,
        senderId: userB,
        targetUserId: userA,
        type: 'call-ringing',
        timestamp: new Date().toISOString(),
      },
      bundleB
    );
    assert.ok(outOfStateRinging);
    const outOfStateRes = await manager.handleIncomingRoomSignal(
      outOfStateRinging,
      convId,
      userB,
      userA
    );
    assert.equal(
      outOfStateRes,
      false,
      'call-ringing while already in connecting state MUST be rejected'
    );

    console.log(
      '✓ [PASS] 4. Pre-SDP signature verification, anti-poisoning replay guard & state transitions'
    );
  }

  // ---------------------------------------------------------------------------
  // 5. Invalid Membership, Fail-Closed Channels & Literal SQL Prefix Verification
  // ---------------------------------------------------------------------------
  {
    assert.equal(
      validateOneToOneConversationMembership({
        conversation: { id: convId, is_group: true, deleted_at: null },
        members: [
          { user_id: userA, deleted_at: null },
          { user_id: userB, deleted_at: null },
        ],
        localUserId: userA,
      }).valid,
      false,
      'Group conversation must be rejected'
    );

    assert.equal(
      validateOneToOneConversationMembership({
        conversation: { id: convId, is_group: false, deleted_at: null },
        members: [
          { user_id: userA, deleted_at: null },
          { user_id: userB, deleted_at: null },
          { user_id: userC, deleted_at: null },
        ],
        localUserId: userA,
      }).valid,
      false,
      '>2 active members must be rejected'
    );

    const manager = new OneToOneVoiceCallManager();
    const ch = await manager.subscribePrivateChannel(`spark_call_inbox_${userA}`, () => {});
    assert.equal(ch, null, 'subscribePrivateChannel must fail closed when unauthenticated');

    // Verify SQL policies have NO unescaped LIKE 'spark_call_%' wildcards and have both RESTRICTIVE SELECT & INSERT
    for (const sqlText of [SUPABASE_MIGRATION_SQL, SUPABASE_SETUP_SQL]) {
      assert.equal(
        /LIKE\s+'spark_call_/i.test(sqlText),
        false,
        'SQL must NOT contain unescaped LIKE spark_call_ (underscores are wildcards in SQL LIKE)'
      );
      assert.match(
        sqlText,
        /LEFT\(realtime\.topic\(\),\s*17\)\s*=\s*'spark_call_inbox_'/i,
        'SQL must match spark_call_inbox_ using literal LEFT(..., 17)'
      );
      assert.match(
        sqlText,
        /LEFT\(realtime\.topic\(\),\s*16\)\s*=\s*'spark_call_1on1_'/i,
        'SQL must match spark_call_1on1_ using literal LEFT(..., 16)'
      );
      assert.match(
        sqlText,
        /LIKE\s+'spark\\_call\\_%'\s+ESCAPE\s+'\\'/i,
        'SQL must escape underscores with ESCAPE \\ in LIKE patterns'
      );
      assert.match(
        sqlText,
        /CREATE POLICY "Restrict spark call topics select"\s+ON realtime\.messages AS RESTRICTIVE\s+FOR SELECT/i,
        'SQL must define RESTRICTIVE FOR SELECT policy on realtime.messages'
      );
      assert.match(
        sqlText,
        /CREATE POLICY "Restrict spark call topics insert"\s+ON realtime\.messages AS RESTRICTIVE\s+FOR INSERT/i,
        'SQL must define RESTRICTIVE FOR INSERT policy on realtime.messages'
      );
    }

    assert.match(
      SUPABASE_SECTION_13_VALIDATION_SQL,
      /FROM pg_policies\s+WHERE schemaname = 'realtime'/i
    );

    console.log(
      '✓ [PASS] 5. Membership validation, fail-closed channels & literal SQL prefix/restrictive RLS invariants'
    );
  }

  console.log('\nALL 5 FINAL SECURITY TEST SUITES PASSED SUCCESSFULLY.');
}

runCallSecurityTestSuite().catch((err) => {
  console.error('Security test suite failed:', err);
  process.exit(1);
});
