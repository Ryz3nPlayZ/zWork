`sales.csv` has our order lines. Write `report.json` with this shape:

{"total_revenue": <sum of quantity*unit_price over all rows, rounded to 2 decimals>,
 "revenue_by_region": {<region>: <revenue rounded to 2 decimals>, ...},
 "top_product": <product name with the highest total quantity sold>,
 "refunded_orders": <number of distinct order_ids that have status "refunded">}

Rows with status "refunded" still count toward refunded_orders but must be EXCLUDED from all revenue numbers and from top_product. Region names should be normalized (trim whitespace, Title Case).
