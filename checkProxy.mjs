import { ethers } from 'ethers';

async function checkStorage() {
  const contractAddress = '0x6f3E6272A167e8AcCb32072d08E0957F9c79223d';
  const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const provider = new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');

  try {
    const storageValue = await provider.getStorage(contractAddress, implementationSlot);
    console.log('Value at implementation slot:');
    console.log(storageValue);

    if (storageValue && storageValue !== '0x' && storageValue !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      const implAddress = '0x' + storageValue.slice(26);
      console.log('Detected Implementation Address:', ethers.getAddress(implAddress));
    } else {
      console.log('No implementation address found at the standard ERC-1967 slot.');
    }

  } catch (error) {
    console.error('Error checking storage:', error);
  }
}

checkStorage();
