import { encodeAbiParameters, keccak256, parseAbiParameters, toBytes, type Address, type Hex } from "viem";



export function hashCommitment(args: {
  chainId: bigint;
  labx: Address;
  nonce: Hex;
  nft: Address;
  tokenId: bigint;
  publicHash: Hex;
  privateHash: Hex;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("uint256, address, bytes32, address, uint256, bytes32, bytes32, bytes32"),
      [args.chainId, args.labx, args.nonce, args.nft, args.tokenId, args.publicHash, args.privateHash, args.salt]
    )
  );
}

export const COMMIT_VECTOR = {
  chainId: 11155111n,
  labx: "0x1111111111111111111111111111111111111111" as Address,
  nonce: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex,
  nft: "0x3333333333333333333333333333333333333333" as Address,
  tokenId: 1n,
  publicHash: "0x4444444444444444444444444444444444444444444444444444444444444444" as Hex,
  privateHash: "0x5555555555555555555555555555555555555555555555555555555555555555" as Hex,
  salt: "0x6666666666666666666666666666666666666666666666666666666666666666" as Hex,
  expected: "0xd80b5e2c1bf070e96e44383790c99e523c461f3639c0fe06070645fd3e655c19" as Hex
};
