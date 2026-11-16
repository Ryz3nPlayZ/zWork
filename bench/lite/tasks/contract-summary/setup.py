"""Writes the contract as a real .docx (stdlib zipfile, minimal WordprocessingML)."""
import zipfile
from xml.sax.saxutils import escape

paras = [
    ("SERVICE AGREEMENT", True),
    ("This Service Agreement is made on 15 January 2026 between Northwind Traders Ltd, of 200 Harbor Street, Portland (the “Client”), and Brightline Cleaning Services LLC (the “Provider”).", False),
    ("1. Services", True),
    ("The Provider will clean the Client’s office at 200 Harbor Street twice a week, on Tuesday and Friday evenings.", False),
    ("2. Term and renewal", True),
    ("This agreement starts on 1 February 2026 and runs for 12 months. It renews automatically for further periods of 12 months unless either party gives written notice at least 60 days before the end of the current term.", False),
    ("3. Fees and payment", True),
    ("The Client pays a monthly fee of USD 1,850.00. The Provider invoices on the first business day of each month, and each invoice is due within 30 days of its date.", False),
    ("4. Late payment", True),
    ("Amounts not paid when due accrue interest of 1.5% per month until paid.", False),
    ("5. Termination", True),
    ("Either party may end this agreement for convenience by giving 90 days’ written notice. Either party may end it immediately if the other materially breaches it and does not fix the breach within 14 days of being told.", False),
    ("6. Insurance", True),
    ("The Provider keeps public liability insurance of at least USD 2,000,000 throughout the term.", False),
    ("Signed for Northwind Traders Ltd: Hannah Cole, Operations Director. Signed for Brightline Cleaning Services LLC: Marcus Webb, Owner.", False),
    ("AMENDMENT No. 1 — dated 10 March 2026", True),
    ("The parties agree the following changes to the Service Agreement dated 15 January 2026. From 1 April 2026 the Provider will clean three times a week, and the monthly fee in Section 3 becomes USD 2,100.00. The interest rate in Section 4 is reduced to 1% per month. All other terms stay the same.", False),
]
body = "".join(
    f'<w:p><w:r>{"<w:rPr><w:b/></w:rPr>" if bold else ""}<w:t xml:space="preserve">{escape(t)}</w:t></w:r></w:p>'
    for t, bold in paras
)
doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
       '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
       f'<w:body>{body}<w:sectPr/></w:body></w:document>')
ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Default Extension="xml" ContentType="application/xml"/>'
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      '</Types>')
rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>')
with zipfile.ZipFile("Service Agreement - Northwind.docx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", ct)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", doc)
